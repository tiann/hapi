import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { EnhancedMode, PermissionMode } from './loop';
import type { CodexCliOverrides } from './utils/codexCliOverrides';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { Metadata, SessionModel, SessionModelReasoningEffort } from '@/api/types';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class CodexSession extends AgentSessionBase<EnhancedMode> {
    transcriptPath: string | null = null;
    readonly codexArgs?: string[];
    readonly codexCliOverrides?: CodexCliOverrides;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    readonly replayTranscriptHistoryOnStart: boolean;
    readonly sourceSessionId?: string;
    localLaunchFailure: LocalLaunchFailure | null = null;

    private transcriptPathCallbacks: Array<(path: string) => void> = [];

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
        model?: SessionModel;
        modelReasoningEffort?: SessionModelReasoningEffort;
        collaborationMode?: EnhancedMode['collaborationMode'];
        replayTranscriptHistoryOnStart?: boolean;
        sourceSessionId?: string;
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
            permissionMode: opts.permissionMode,
            model: opts.model,
            modelReasoningEffort: opts.modelReasoningEffort,
            collaborationMode: opts.collaborationMode
        });

        this.codexArgs = opts.codexArgs;
        this.codexCliOverrides = opts.codexCliOverrides;
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.replayTranscriptHistoryOnStart = opts.replayTranscriptHistoryOnStart ?? false;
        this.sourceSessionId = opts.sourceSessionId;
        this.permissionMode = opts.permissionMode;
        this.model = opts.model;
        this.modelReasoningEffort = opts.modelReasoningEffort;
        this.collaborationMode = opts.collaborationMode;
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

    resetTranscriptPath(): void {
        this.transcriptPath = null;
    }

    resetCodexThread(): void {
        this.sessionId = null;
        this.resetTranscriptPath();
        this.client.updateMetadata((metadata: Metadata) => {
            // Explicit-clear sentinel: `null` instructs the hub merge to
            // drop `codexSessionId` from the persisted blob. Plain
            // `delete` arrives at the hub as an omitted field, which the
            // carry-forward path then restores from the prior row —
            // defeating the reset. See hub/src/store/sessions.ts
            // mergeSessionMetadata. The value is `null` on the wire only;
            // MetadataSchema parses `string().optional()`, so the
            // post-merge persisted blob carries no key.
            const updated: Record<string, unknown> = { ...metadata, codexSessionId: null };
            return updated as unknown as Metadata;
        });
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: SessionModel): void => {
        this.model = model;
    };

    setModelReasoningEffort = (modelReasoningEffort: SessionModelReasoningEffort): void => {
        this.modelReasoningEffort = modelReasoningEffort;
    };

    setCollaborationMode = (mode: EnhancedMode['collaborationMode']): void => {
        this.collaborationMode = mode;
        this.pushKeepAlive();
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message);
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    notifyUserActivity = (): void => {
        this.client.notifyUserActivity();
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
