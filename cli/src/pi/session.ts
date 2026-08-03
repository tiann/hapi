import type { ApiClient, ApiSessionClient } from '@/lib';
import type { Metadata } from '@/api/types';
import type { PiCommandSummary, PiThinkingLevel } from './types';
import type { PiModelSummary } from '@hapi/protocol/apiTypes';
import type { PiRpcResolver } from './loop';

/**
 * The parts of `get_state` which must move atomically with a native session
 * identity transition. `undefined` means the Pi version did not report that
 * field, so an already-confirmed value must remain intact.
 */
export type PiNativeRuntimeState = {
    model?: string | null;
    provider?: string | null;
    thinkingLevel?: PiThinkingLevel | null;
    steeringMode?: 'all' | 'one-at-a-time';
    isStreaming?: boolean;
};

/**
 * Pi session state and hub communication wrapper.
 *
 * Unlike other agents that extend AgentSessionBase (which requires MessageQueue2),
 * Pi sends messages directly via PiTransport RPC — no queue needed.
 * This class manages Pi-specific runtime state and hub keepAlive.
 */
export class PiSession {
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly path: string;
    readonly logPath: string;
    readonly startedBy: 'runner' | 'terminal';
    // Mutable mode — updated by setMode() when the hub switches control
    // (local ↔ remote). keepAlive reads this so the reported mode does not
    // revert to the constructor-time startingMode every 2s tick.
    mode: 'local' | 'remote';

    // Config state — synced to hub via keepAlive.
    // `undefined` means "not yet known" and is OMITTED from keepAlive so the hub
    // does not clear a persisted value; `null` is an explicit clear. A value is
    // only assigned once Pi confirms it (get_state / successful set_model /
    // successful set_thinking_level).
    currentModel: string | null | undefined;
    currentThinkingLevel: PiThinkingLevel | null | undefined;
    // Pi's set_model requires provider + modelId; learned from get_state
    currentProvider: string | null = null;
    // Startup model from opts.model — prevents get_state from overwriting it
    // with Pi's default. Applied once when get_available_models returns.
    readonly initialModel: string | null;
    // A runner/native resume must prove that Pi loaded this exact session with
    // a non-empty get_state sessionId. Missing or contradictory IDs fail closed.
    expectedNativeSessionId: string | null;
    currentNativeSessionFile: string | null = null;

    // Streaming state. A generation identifies one concrete Pi turn, rather
    // than merely the transient boolean reported by get_state/lifecycle events.
    // Native steers capture it at arrival and must not cross into a later turn.
    private _piIsStreaming = false;
    private streamingGeneration = 0;
    private promptInFlight = false;
    currentSteeringMode: 'all' | 'one-at-a-time' = 'all';

    // Cached data from Pi
    cachedPiModels: PiModelSummary[] = [];
    cachedPiCommands: PiCommandSummary[] = [];

    // RPC resolver — initialized by wireTransportEvents, session-scoped
    rpcResolver: PiRpcResolver | null = null;

    // Startup ready gate (issue #1143). Pi's socket goes `active` (spawn success)
    // before `pi --mode rpc` returns its initial `get_state`, so a prompt sent
    // in that window reaches Pi before its session is initialized and wedges
    // (agent_start, then silence). Outbound sends that assume a live Pi session
    // are queued via runWhenReady() and drained FIFO once markReady() fires (on
    // the first get_state response).
    private piReady = false;
    private readyCancelled = false;
    private nativeReadyAnnounced = false;
    private nativeReadyPreparation: (() => Promise<void>) | null = null;
    private nativeReadyPreparationStarted = false;
    private historyTransaction: symbol | null = null;
    // All commands that mutate the native Pi runtime (history clone/fork/switch,
    // model/thinking changes, and abort) share one FIFO lock. A history action
    // closes its prompt gate before waiting on this tail, which prevents a later
    // runtime mutation from slipping between its final source sync and fork.
    private runtimeMutationTail: Promise<void> = Promise.resolve();
    // Buffered sends carry their localId so a cancel-queued-message that arrives
    // while a prompt is still held (before drain) can drop it instead of firing
    // a cancelled prompt on markReady (issue #1143 review — MAJOR).
    private readyQueue: Array<{ localId?: string; fn: () => void }> = [];
    private historyDeferredQueue: Array<{ localId?: string; fn: () => void }> = [];

    private keepAliveInterval: NodeJS.Timeout | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        model?: string | null;
        expectedNativeSessionId?: string;
    }) {
        this.api = opts.api;
        this.client = opts.client;
        this.path = opts.path;
        this.logPath = opts.logPath;
        this.startedBy = opts.startedBy;
        this.mode = opts.startingMode;
        // currentModel/currentThinkingLevel start undefined ("not yet known")
        // and are set only from Pi's confirmed state (get_state) or a successful
        // set_model/set_thinking_level. Seeding from opts.model/opts.effort here
        // would leak unconfirmed values via the first keepAlive; they are captured
        // as initialModel/startupThinkingLevel and applied once Pi accepts them.
        // undefined is distinct from null (explicit clear): keepAlive omits
        // undefined fields so the hub does not wipe a persisted model/effort on
        // resume before Pi reports its real state.
        this.currentModel = undefined;
        this.initialModel = opts.model?.trim() || null;
        this.expectedNativeSessionId = opts.expectedNativeSessionId?.trim() || null;
        this.currentThinkingLevel = undefined;
    }

    /** True once Pi RPC startup has completed and buffered sends have drained. */
    get isReady(): boolean {
        return this.piReady;
    }

    /** True only after Pi itself has completed a successful get_state. */
    get isNativeReady(): boolean {
        return this.nativeReadyAnnounced;
    }

    /**
     * Establish a stable native baseline before buffered prompts are released.
     * Pi's history cursor must be read before the first web prompt is allowed
     * to append, otherwise an old duplicate user message could be paired with
     * a new HAPI localId.
     */
    setNativeReadyPreparation(fn: () => Promise<void>): void {
        this.nativeReadyPreparation = fn;
    }

    /** Prevent any late startup/history completion from draining outbound work. */
    cancelReadyGate(): void {
        this.readyCancelled = true;
        this.readyQueue = [];
        this.historyDeferredQueue = [];
    }

    get isHistoryTransactionActive(): boolean {
        return this.historyTransaction !== null;
    }

    /** True from prompt dispatch until rejection, abort, or true settlement. */
    get hasPromptInFlight(): boolean {
        return this.promptInFlight;
    }

    get piIsStreaming(): boolean {
        return this._piIsStreaming;
    }

    set piIsStreaming(value: boolean) {
        // Keep direct state reconciliation (including test adapters) on the
        // same transition invariant as updateThinkingState().
        if (value && !this._piIsStreaming) this.streamingGeneration += 1;
        this._piIsStreaming = value;
    }

    /** Exact identity of the active Pi stream; absent while Pi is idle. */
    get currentStreamingGeneration(): number | null {
        return this._piIsStreaming ? this.streamingGeneration : null;
    }

    setPromptInFlight(value: boolean): void {
        this.promptInFlight = value;
    }

    beginHistoryTransaction(): (options?: { drain?: boolean }) => void {
        if (this.historyTransaction) throw new Error('Conversation history action already in progress');
        const token = Symbol('pi-history-transaction');
        this.historyTransaction = token;
        return (options = {}) => {
            if (this.historyTransaction !== token) return;
            this.historyTransaction = null;
            const deferred = this.historyDeferredQueue;
            this.historyDeferredQueue = [];
            if (options.drain === false) return;
            for (const { fn } of deferred) fn();
        };
    }

    /**
     * Acquire exclusive ownership of the native Pi runtime. Callers which need
     * a transaction spanning multiple RPCs (conversation history) can retain
     * the release callback; single RPC handlers should use runRuntimeMutation.
     */
    async acquireRuntimeMutation(): Promise<() => void> {
        const previous = this.runtimeMutationTail;
        let releaseCurrent!: () => void;
        this.runtimeMutationTail = new Promise<void>((resolve) => {
            releaseCurrent = resolve;
        });
        await previous;

        let released = false;
        return () => {
            if (released) return;
            released = true;
            releaseCurrent();
        };
    }

    /** Serialize one Pi runtime mutation behind any active history operation. */
    async runRuntimeMutation<T>(
        operation: () => Promise<T>,
        options: { poisonOnError?: (error: unknown) => boolean } = {},
    ): Promise<T> {
        const release = await this.acquireRuntimeMutation();
        let releaseLease = true;
        try {
            return await operation();
        } catch (error) {
            if (options.poisonOnError?.(error)) releaseLease = false;
            throw error;
        } finally {
            if (releaseLease) release();
        }
    }

    assertNoHistoryTransaction(operation: string): void {
        if (this.historyTransaction) {
            throw new Error(`Cannot ${operation} while a conversation history action is in progress`);
        }
    }

    /** Queue ordinary outbound work until native source identity is restored. */
    runWhenHistoryIdle(fn: () => void, localId?: string): void {
        if (!this.historyTransaction) {
            fn();
            return;
        }
        this.historyDeferredQueue.push({ fn, localId });
    }

    matchesExpectedNativeSessionId(actualSessionId: string | undefined): boolean {
        if (!this.expectedNativeSessionId) return true;
        return Boolean(actualSessionId) && actualSessionId === this.expectedNativeSessionId;
    }

    /**
     * Commit an in-process native session transition (Pi rewind creates a new
     * branched session file). Future get_state validation must target the new
     * id before its metadata is exposed to the hub.
     */
    commitNativeSessionIdentity(
        identity: { sessionId: string; sessionFile: string },
        metadataUpdater?: (metadata: Metadata) => Metadata,
    ): void {
        this.commitNativeSessionState(identity, {}, metadataUpdater);
    }

    /**
     * Commit a confirmed get_state snapshot after a native session transition.
     * This intentionally updates runtime values before metadata is made visible
     * so the next keepAlive cannot report the old branch configuration.
     */
    commitNativeSessionState(
        identity: { sessionId: string; sessionFile: string },
        runtime: PiNativeRuntimeState,
        metadataUpdater?: (metadata: Metadata) => Metadata,
    ): void {
        const identityChanged = this.expectedNativeSessionId !== identity.sessionId
            || this.currentNativeSessionFile !== identity.sessionFile;
        // A rewind can replace the native branch while both snapshots report
        // streaming=true. Invalidate any steer captured for the old branch
        // even though the boolean never passed through an observable idle edge.
        if (identityChanged && this._piIsStreaming && runtime.isStreaming !== false) {
            this.streamingGeneration += 1;
        }
        this.expectedNativeSessionId = identity.sessionId;
        this.currentNativeSessionFile = identity.sessionFile;
        this.applyNativeRuntimeState(runtime);
        this.updateMetadata((metadata) => {
            let next = metadataUpdater?.({
                ...metadata,
                piSessionId: identity.sessionId,
            }) ?? {
                ...metadata,
                piSessionId: identity.sessionId,
            };
            // A get_state model/provider pair is the authoritative provider-
            // qualified selection for the newly active native branch. Preserve
            // existing metadata only when an older Pi omitted both fields.
            if (runtime.model !== undefined || runtime.provider !== undefined) {
                next = { ...next };
                delete next.piSelectedModel;
                if (this.currentModel && this.currentProvider) {
                    next.piSelectedModel = {
                        provider: this.currentProvider,
                        modelId: this.currentModel,
                    };
                }
            }
            return next;
        });
    }

    /** Apply a confirmed state snapshot without changing native identity metadata. */
    applyNativeRuntimeState(runtime: PiNativeRuntimeState): void {
        if (runtime.model !== undefined) {
            if (runtime.provider === undefined && runtime.model !== this.currentModel) {
                if (runtime.model === null) {
                    this.currentProvider = null;
                } else {
                    const matchingProviders = new Set(
                        this.cachedPiModels
                            .filter((model) => model.modelId === runtime.model)
                            .map((model) => model.provider),
                    );
                    // Never combine a newly reported model id with the previous
                    // branch's provider. Infer only from an unambiguous catalog.
                    this.currentProvider = matchingProviders.size === 1
                        ? matchingProviders.values().next().value ?? null
                        : null;
                }
            }
            this.currentModel = runtime.model;
        }
        if (runtime.provider !== undefined) this.currentProvider = runtime.provider;
        if (runtime.thinkingLevel !== undefined) this.currentThinkingLevel = runtime.thinkingLevel;
        if (runtime.steeringMode !== undefined) this.currentSteeringMode = runtime.steeringMode;
        if (runtime.isStreaming !== undefined) this.piIsStreaming = runtime.isStreaming;
        this.pushKeepAlive();
    }

    /** Wait for queued metadata writes before exposing a native history result. */
    async flushMetadata(timeoutMs: number = 5_000): Promise<boolean> {
        const flush = (this.client as Partial<ApiSessionClient>).flushMetadata
        return flush ? await flush.call(this.client, timeoutMs) : true
    }

    /**
     * Run `fn` now if Pi startup is ready, else buffer it FIFO until markReady().
     * Used to gate outbound prompt/steer sends so they never reach Pi before its
     * session is initialized (issue #1143). Pass the message `localId` so a
     * cancel-queued-message can drop it while still buffered.
     */
    runWhenReady(fn: () => void, localId?: string): void {
        if (this.readyCancelled) return;
        if (this.piReady) {
            fn();
            return;
        }
        this.readyQueue.push({ localId, fn });
    }

    /**
     * Drop a still-buffered send by localId (cancel-queued-message contract).
     * Returns true if it was buffered and removed (so the hub un-queues the row),
     * false if it was already drained/sent to Pi or never buffered (best-effort,
     * mirrors the other agents' queue.cancelByLocalId semantics).
     */
    cancelBufferedMessage(localId: string): boolean {
        const idx = this.readyQueue.findIndex((item) => item.localId === localId);
        if (idx !== -1) {
            this.readyQueue.splice(idx, 1);
            return true;
        }
        const deferredIdx = this.historyDeferredQueue.findIndex((item) => item.localId === localId);
        if (deferredIdx === -1) return false;
        this.historyDeferredQueue.splice(deferredIdx, 1);
        return true;
    }

    /**
     * Release buffered sends. This intentionally does not notify the hub: the
     * startup fallback may use it to avoid losing prompts, but is not proof that
     * Pi loaded a requested native session.
     */
    markReady(): boolean {
        if (this.piReady || this.readyCancelled) return false;
        this.piReady = true;
        const queued = this.readyQueue;
        this.readyQueue = [];
        for (const { fn } of queued) fn();
        return true;
    }

    /**
     * The first successful Pi get_state is the authoritative native-ready
     * point. Unlike markReady(), this tells the hub that a native resume can be
     * considered successful.
     */
    markNativeReady(): void {
        if (this.readyCancelled || this.nativeReadyAnnounced || this.nativeReadyPreparationStarted) return;
        // The hub uses session-ready as the validated native identity fence.
        // It must precede piSessionId metadata publication, while prompt drain
        // may wait for the append-log baseline below.
        this.nativeReadyAnnounced = true;
        this.client.emitSessionReady();
        if (this.nativeReadyPreparation) {
            this.nativeReadyPreparationStarted = true;
            void this.nativeReadyPreparation()
                // The history feature is optional. A failed baseline must not
                // wedge a normal Pi session; it simply remains unpublished.
                .catch(() => {})
                .finally(() => this.finishNativeReady());
            return;
        }
        this.finishNativeReady();
    }

    private finishNativeReady(): void {
        this.markReady();
    }

    startKeepAlive(): void {
        this.pushKeepAlive();
        this.keepAliveInterval = setInterval(() => this.pushKeepAlive(), 2000);
    }

    stopKeepAlive(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    private getKeepAliveRuntime(): Parameters<ApiSessionClient['keepAlive']>[2] {
        const runtime: NonNullable<Parameters<ApiSessionClient['keepAlive']>[2]> = {};
        if (this.currentModel !== undefined) runtime.model = this.currentModel;
        if (this.currentThinkingLevel !== undefined) runtime.effort = this.currentThinkingLevel;
        return Object.keys(runtime).length > 0 ? runtime : undefined;
    }

    pushKeepAlive(): void {
        this.client.keepAlive(this.piIsStreaming, this.mode, this.getKeepAliveRuntime());
    }

    updateThinkingState(thinking: boolean): void {
        this.piIsStreaming = thinking;
        this.client.keepAlive(thinking, this.mode, this.getKeepAliveRuntime());
    }

    setMode(mode: 'local' | 'remote'): void {
        this.mode = mode;
        this.pushKeepAlive();
    }

    updateMetadata(updater: (meta: Metadata) => Metadata): void {
        this.client.updateMetadata(updater);
    }

    sendAgentMessage(message: unknown): void {
        this.client.sendAgentMessage(message);
    }

    emitMessagesConsumed(localIds: string[], options?: { clearQueuedThinkingGrace?: boolean }): void {
        this.client.emitMessagesConsumed(localIds, options);
    }

    sendSessionEvent(event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void {
        this.client.sendSessionEvent(event);
    }
}
