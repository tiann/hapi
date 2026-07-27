import type { ApiClient, ApiSessionClient } from '@/lib';
import type { Metadata } from '@/api/types';
import type { OmpCommandSummary, PiThinkingLevel } from './types';
import type { OmpModelSummary } from '@hapi/protocol/apiTypes';
import type { OmpRpcResolver } from './loop';

/**
 * OMP session state and hub communication wrapper.
 *
 * Like Pi, OMP sends messages directly via OmpTransport RPC — no queue
 * needed (unlike agents that extend AgentSessionBase). This class manages
 * OMP-specific runtime state and hub keepAlive.
 */
export class OmpSession {
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
    // only assigned once OMP confirms it (get_state / successful set_model /
    // successful set_thinking_level).
    currentModel: string | null | undefined;
    currentThinkingLevel: PiThinkingLevel | null | undefined;
    // OMP's set_model requires provider + modelId; learned from get_state
    currentProvider: string | null = null;
    // Startup model from opts.model — prevents get_state from overwriting it
    // with OMP's default. Applied once when get_available_models returns.
    readonly initialModel: string | null;
    // Guards against re-applying initialModel if get_available_models fires
    // more than once (startup request racing with a ListOmpModels RPC). Once
    // true, subsequent responses skip the startup-model apply branch so a model
    // the user picked in between isn't clobbered.
    initialModelApplied = false;
    // Guards the startup thinking-level apply: once the user changes effort via
    // SetSessionConfig (or the startup apply has run), this flips so a late
    // startup-level confirmation can't clobber the user's choice.
    initialThinkingLevelApplied = false;

    // Streaming state
    ompIsStreaming = false;
    // OMP steering/follow-up/interrupt modes (superset of Pi). Tracked from
    // get_state; switchable via set_steering_mode / set_follow_up_mode /
    // set_interrupt_mode RPC. Not yet surfaced in keepAlive runtime (which is
    // a fixed shape); stored on metadata for web visibility if needed later.
    currentSteeringMode: 'all' | 'one-at-a-time' = 'all';
    currentFollowUpMode: 'all' | 'one-at-a-time' = 'all';
    currentInterruptMode: 'immediate' | 'wait' = 'wait';

    // Cached data from OMP
    cachedOmpModels: OmpModelSummary[] = [];
    cachedOmpCommands: OmpCommandSummary[] = [];

    // RPC resolver — initialized by wireTransportEvents, session-scoped
    rpcResolver: OmpRpcResolver | null = null;

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
        // and are set only from OMP's confirmed state (get_state) or a successful
        // set_model/set_thinking_level. Seeding from opts.model/opts.effort here
        // would leak unconfirmed values via the first keepAlive; they are captured
        // as initialModel and applied once OMP accepts them.
        // undefined is distinct from null (explicit clear): keepAlive omits
        // undefined fields so the hub does not wipe a persisted model/effort on
        // resume before OMP reports its real state.
        this.currentModel = undefined;
        this.initialModel = opts.model?.trim() || null;
        this.currentThinkingLevel = undefined;
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
        this.client.keepAlive(this.ompIsStreaming, this.mode, this.getKeepAliveRuntime());
    }

    updateThinkingState(thinking: boolean): void {
        this.ompIsStreaming = thinking;
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

    /**
     * Push a web-visible agent event (goal/compact/notice/etc.) via the
     * open `sendAgentMessage` channel. The web `normalizeAgent` dispatches
     * on `body.type` (e.g. 'thread_goal_updated', 'compact'), with a
     * catch-all for unknown types — so OMP-only events pass through too.
     */
    sendAgentEvent(body: unknown): void {
        // Route through sendAgentMessage so any future unified logic on that
        // path (logging/interception) also covers structured events.
        this.sendAgentMessage(body);
    }

    emitMessagesConsumed(localIds: string[], options?: { clearQueuedThinkingGrace?: boolean }): void {
        this.client.emitMessagesConsumed(localIds, options);
    }

    sendSessionEvent(event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void {
        this.client.sendSessionEvent(event);
    }
}
