import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { Metadata } from '@/api/types';
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

    private readonly applySessionIdToMetadata: (metadata: Metadata, sessionId: string) => Metadata;
    private readonly sessionLabel: string;
    private readonly sessionIdLabel: string;
    private keepAliveInterval: NodeJS.Timeout | null = null;

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

        this.client.keepAlive(this.thinking, this.mode);
        this.keepAliveInterval = setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode);
        }, 2000);
    }

    onThinkingChange = (thinking: boolean) => {
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode);
    };

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode);
        this._onModeChange(mode);
    };

    onSessionFound = (sessionId: string) => {
        this.sessionId = sessionId;
        this.client.updateMetadata((metadata) => this.applySessionIdToMetadata(metadata, sessionId));
        logger.debug(`[${this.sessionLabel}] ${this.sessionIdLabel} session ID ${sessionId} added to metadata`);
    };

    stopKeepAlive = (): void => {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    };
}
