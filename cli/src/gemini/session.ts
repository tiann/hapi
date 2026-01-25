import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { GeminiMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class GeminiSession extends AgentSessionBase<GeminiMode> {
    transcriptPath: string | null = null;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    readonly resumeSessionId?: string;
    localLaunchFailure: LocalLaunchFailure | null = null;

    private transcriptPathCallbacks: Array<(path: string) => void> = [];

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<GeminiMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        permissionMode?: PermissionMode;
        resumeSessionId?: string;
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
            sessionLabel: 'GeminiSession',
            sessionIdLabel: 'Gemini',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                geminiSessionId: sessionId
            }),
            permissionMode: opts.permissionMode
        });

        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.resumeSessionId = opts.resumeSessionId;
    }

    onTranscriptPathFound(path: string): void {
        if (this.transcriptPath === path) {
            return;
        }
        this.transcriptPath = path;
        for (const callback of this.transcriptPathCallbacks) {
            callback(path);
        }
    }

    addTranscriptPathCallback(cb: (path: string) => void): void {
        this.transcriptPathCallbacks.push(cb);
    }

    removeTranscriptPathCallback(cb: (path: string) => void): void {
        const index = this.transcriptPathCallbacks.indexOf(cb);
        if (index !== -1) {
            this.transcriptPathCallbacks.splice(index, 1);
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

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
