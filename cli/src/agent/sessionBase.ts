import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type {
    Metadata,
    SessionCollaborationMode,
    SessionEffort,
    SessionModel,
    SessionModelReasoningEffort,
    SessionPermissionMode
} from '@/api/types';
import { logger } from '@/ui/logger';

export type AgentSessionBaseOptions<Mode> = {
    api: ApiClient;
    client: ApiSessionClient;
    path: string;
    logPath: string;
    sessionId: string | null;
    messageQueue: MessageQueue2<Mode>;
    onModeChange: (mode: 'local' | 'remote') => void;
    mode?: 'local' | 'remote';
    sessionLabel: string;
    sessionIdLabel: string;
    applySessionIdToMetadata: (metadata: Metadata, sessionId: string) => Metadata;
    permissionMode?: SessionPermissionMode;
    model?: SessionModel;
    modelReasoningEffort?: SessionModelReasoningEffort;
    effort?: SessionEffort;
    collaborationMode?: SessionCollaborationMode;
};

export class AgentSessionBase<Mode> {
    readonly path: string;
    readonly logPath: string;
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly queue: MessageQueue2<Mode>;
    protected readonly _onModeChange: (mode: 'local' | 'remote') => void;

    sessionId: string | null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;

    private sessionFoundCallbacks: ((sessionId: string) => void)[] = [];
    private readonly applySessionIdToMetadata: (metadata: Metadata, sessionId: string) => Metadata;
    private readonly sessionLabel: string;
    private readonly sessionIdLabel: string;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    protected permissionMode?: SessionPermissionMode;
    protected model?: SessionModel;
    protected modelReasoningEffort?: SessionModelReasoningEffort;
    protected effort?: SessionEffort;
    protected collaborationMode?: SessionCollaborationMode;

    constructor(opts: AgentSessionBaseOptions<Mode>) {
        this.path = opts.path;
        this.api = opts.api;
        this.client = opts.client;
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this._onModeChange = opts.onModeChange;
        this.applySessionIdToMetadata = opts.applySessionIdToMetadata;
        this.sessionLabel = opts.sessionLabel;
        this.sessionIdLabel = opts.sessionIdLabel;
        this.mode = opts.mode ?? 'local';
        this.permissionMode = opts.permissionMode;
        this.model = opts.model;
        this.modelReasoningEffort = opts.modelReasoningEffort;
        this.effort = opts.effort;
        this.collaborationMode = opts.collaborationMode;

        this.queue.onBatchConsumed = (localIds) => this.client.emitMessagesConsumed(localIds);

        this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
        this.keepAliveInterval = setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
        }, 2000);

    }

    onThinkingChange = (thinking: boolean) => {
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode, this.getKeepAliveRuntime());
    };

    pushKeepAlive = () => {
        this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
    };

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode, this.getKeepAliveRuntime());
        const permissionLabel = this.permissionMode ?? 'unset';
        const modelLabel = this.model === undefined ? 'unset' : (this.model ?? 'auto');
        const modelReasoningEffortLabel = this.modelReasoningEffort === undefined ? 'unset' : (this.modelReasoningEffort ?? 'default');
        const effortLabel = this.effort === undefined ? 'unset' : (this.effort ?? 'auto');
        const collaborationLabel = this.collaborationMode ?? 'unset';
        logger.debug(
            `[${this.sessionLabel}] Mode switched to ${mode} ` +
            `(permissionMode=${permissionLabel}, model=${modelLabel}, modelReasoningEffort=${modelReasoningEffortLabel}, effort=${effortLabel}, collaborationMode=${collaborationLabel})`
        );
        this._onModeChange(mode);
    };

    onSessionFound = (sessionId: string) => {
        this.sessionId = sessionId;
        this.client.updateMetadata((metadata) => this.applySessionIdToMetadata(metadata, sessionId));
        logger.debug(`[${this.sessionLabel}] ${this.sessionIdLabel} session ID ${sessionId} added to metadata`);

        for (const callback of this.sessionFoundCallbacks) {
            callback(sessionId);
        }
    };

    addSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        this.sessionFoundCallbacks.push(callback);
    };

    removeSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        const index = this.sessionFoundCallbacks.indexOf(callback);
        if (index !== -1) {
            this.sessionFoundCallbacks.splice(index, 1);
        }
    };

    stopKeepAlive = (): void => {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    };

    protected getKeepAliveRuntime():
        {
            permissionMode?: SessionPermissionMode
            model?: SessionModel
            modelReasoningEffort?: SessionModelReasoningEffort
            effort?: SessionEffort
            collaborationMode?: SessionCollaborationMode
        } | undefined {
        if (
            this.permissionMode === undefined
            && this.model === undefined
            && this.modelReasoningEffort === undefined
            && this.effort === undefined
            && this.collaborationMode === undefined
        ) {
            return undefined;
        }
        return {
            permissionMode: this.permissionMode,
            model: this.model,
            modelReasoningEffort: this.modelReasoningEffort,
            effort: this.effort,
            collaborationMode: this.collaborationMode
        };
    }

    getPermissionMode(): SessionPermissionMode | undefined {
        return this.permissionMode;
    }

    getModel(): SessionModel | undefined {
        return this.model;
    }

    getModelReasoningEffort(): SessionModelReasoningEffort | undefined {
        return this.modelReasoningEffort;
    }

    getEffort(): SessionEffort | undefined {
        return this.effort;
    }

    getCollaborationMode(): SessionCollaborationMode | undefined {
        return this.collaborationMode;
    }
}
