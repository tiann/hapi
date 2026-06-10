import type { ApiClient, ApiSessionClient } from '@/lib';
import type { Metadata } from '@/api/types';
import type { PiPermissionMode } from '@hapi/protocol/modes';
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
    readonly startingMode: 'local' | 'remote';

    // Config state — synced to hub via keepAlive
    currentPermissionMode: PiPermissionMode;
    currentModel: string | null;
    currentThinkingLevel: PiThinkingLevel | null;
    // Pi's set_model requires provider + modelId; learned from get_state
    currentProvider: string | null = null;

    // Streaming state
    piIsStreaming = false;
    currentSteeringMode: 'all' | 'one-at-a-time' = 'all';

    // Cached data from Pi
    cachedPiModels: PiModelSummary[] = [];
    cachedPiCommands: PiCommandSummary[] = [];

    // RPC resolver — initialized by wireTransportEvents, session-scoped
    rpcResolver: PiRpcResolver | null = null;

    private keepAliveInterval: NodeJS.Timeout | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        permissionMode?: PiPermissionMode;
        model?: string | null;
    }) {
        this.api = opts.api;
        this.client = opts.client;
        this.path = opts.path;
        this.logPath = opts.logPath;
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.currentPermissionMode = opts.permissionMode ?? 'default';
        this.currentModel = opts.model ?? null;
        this.currentThinkingLevel = null;
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

    pushKeepAlive(): void {
        this.client.keepAlive(this.piIsStreaming, this.startingMode, {
            permissionMode: this.currentPermissionMode,
            model: this.currentModel,
            effort: this.currentThinkingLevel,
        });
    }

    updateThinkingState(thinking: boolean): void {
        this.piIsStreaming = thinking;
        this.client.keepAlive(thinking, this.startingMode, {
            permissionMode: this.currentPermissionMode,
            model: this.currentModel,
            effort: this.currentThinkingLevel,
        });
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
