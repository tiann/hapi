import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { OpencodeHookEvent, OpencodeMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { MessageMeta } from '@/api/types';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class OpencodeSession extends AgentSessionBase<OpencodeMode> {
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;

    private hookEventHandlers: Array<(event: OpencodeHookEvent) => void> = [];

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<OpencodeMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        permissionMode?: PermissionMode;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'OpencodeSession',
            sessionIdLabel: 'OpenCode',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                opencodeSessionId: sessionId
            }),
            permissionMode: opts.permissionMode
        });

        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
    }

    addHookEventHandler(cb: (event: OpencodeHookEvent) => void): void {
        this.hookEventHandlers.push(cb);
    }

    removeHookEventHandler(cb: (event: OpencodeHookEvent) => void): void {
        const index = this.hookEventHandlers.indexOf(cb);
        if (index !== -1) {
            this.hookEventHandlers.splice(index, 1);
        }
    }

    emitHookEvent(event: OpencodeHookEvent): void {
        for (const handler of this.hookEventHandlers) {
            handler(event);
        }
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendCodexMessage = (message: unknown): void => {
        this.client.sendCodexMessage(message);
    };

    sendUserMessage = (text: string, meta?: MessageMeta): void => {
        this.client.sendUserMessage(text, meta);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
