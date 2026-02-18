import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { EnhancedMode, PermissionMode } from './loop';
import type { CodexCliOverrides } from './utils/codexCliOverrides';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { MessageMeta } from '@/api/types';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class CodexSession extends AgentSessionBase<EnhancedMode> {
    readonly codexArgs?: string[];
    readonly codexCliOverrides?: CodexCliOverrides;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<EnhancedMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        codexArgs?: string[];
        codexCliOverrides?: CodexCliOverrides;
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
            sessionLabel: 'CodexSession',
            sessionIdLabel: 'Codex',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                codexSessionId: sessionId
            }),
            permissionMode: opts.permissionMode
        });

        this.codexArgs = opts.codexArgs;
        this.codexCliOverrides = opts.codexCliOverrides;
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
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
