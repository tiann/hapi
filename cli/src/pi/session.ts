import type { ApiClient, ApiSessionClient } from '@/lib';
import type { Metadata } from '@/api/types';
import type { PiCommandSummary, PiThinkingLevel } from './types';
import type { PiModelSummary } from '@hapi/protocol/apiTypes';
import type { PiRpcResolver } from './loop';

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

    // Streaming state
    piIsStreaming = false;
    currentSteeringMode: 'all' | 'one-at-a-time' = 'all';

    // Cached data from Pi
    cachedPiModels: PiModelSummary[] = [];
    cachedPiCommands: PiCommandSummary[] = [];

    // RPC resolver — initialized by wireTransportEvents, session-scoped
    rpcResolver: PiRpcResolver | null = null;

    // Startup ready gate (issue #1143). Pi's socket goes `active` (spawn success)
    // before `pi --mode rpc` finishes `new_session`/`get_state`, so a prompt sent
    // in that window reaches Pi before its session is initialized and wedges
    // (agent_start, then silence). Outbound sends that assume a live Pi session
    // are queued via runWhenReady() and drained FIFO once markReady() fires (on
    // the first get_state response).
    private piReady = false;
    private readyQueue: Array<() => void> = [];

    private keepAliveInterval: NodeJS.Timeout | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        model?: string | null;
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
        this.currentThinkingLevel = undefined;
    }

    /** True once Pi RPC startup has completed and buffered sends have drained. */
    get isReady(): boolean {
        return this.piReady;
    }

    /**
     * Run `fn` now if Pi startup is ready, else buffer it FIFO until markReady().
     * Used to gate outbound prompt/steer sends so they never reach Pi before its
     * session is initialized (issue #1143).
     */
    runWhenReady(fn: () => void): void {
        if (this.piReady) {
            fn();
            return;
        }
        this.readyQueue.push(fn);
    }

    /**
     * Signal that Pi RPC startup is complete (first get_state response).
     * Drains buffered sends in enqueue order. Idempotent — later get_state
     * responses (or the startup fallback timer) are no-ops.
     */
    markReady(): void {
        if (this.piReady) return;
        this.piReady = true;
        const queued = this.readyQueue;
        this.readyQueue = [];
        for (const fn of queued) fn();
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
