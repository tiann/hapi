import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { EnhancedMode, PermissionMode } from './loop';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { CursorSessionProtocol } from './utils/cursorProtocol';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

type CursorModelApplyHandler = (model: string | null | undefined) => Promise<string | null>;

export class CursorSession extends AgentSessionBase<EnhancedMode> {
    readonly cursorArgs?: string[];
    /** Cursor-native `--worktree` name (`true` = flag without name). */
    readonly cursorWorktree?: boolean | string;
    /** Extra `--add-dir` roots for Cursor ACP spawn. */
    readonly cursorAddDirs?: readonly string[];
    model?: string;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;
    private modelApplyHandler: CursorModelApplyHandler | null = null;

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
        cursorArgs?: string[];
        cursorWorktree?: boolean | string;
        cursorAddDirs?: readonly string[];
        model?: string;
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
            sessionLabel: 'CursorSession',
            sessionIdLabel: 'Cursor',
            applySessionIdToMetadata: (metadata, sessionId, extras) => ({
                ...metadata,
                cursorSessionId: sessionId,
                ...extras
            }),
            permissionMode: opts.permissionMode
        });

        this.cursorArgs = opts.cursorArgs;
        this.cursorWorktree = opts.cursorWorktree;
        this.cursorAddDirs = opts.cursorAddDirs;
        this.model = opts.model;
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: string | null | undefined): void => {
        this.model = model ?? undefined;
    };

    registerModelApplyHandler = (handler: CursorModelApplyHandler): (() => void) => {
        this.modelApplyHandler = handler;
        return () => {
            if (this.modelApplyHandler === handler) {
                this.modelApplyHandler = null;
            }
        };
    };

    canApplyModelConfig = (): boolean => this.modelApplyHandler !== null;

    applyModelConfig = async (model: string | null | undefined): Promise<string | null> => {
        if (!this.modelApplyHandler) {
            throw new Error('Cursor ACP session is not ready to apply model changes');
        }
        return await this.modelApplyHandler(model);
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

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };

    onSessionFoundWithProtocol = (sessionId: string, protocol: CursorSessionProtocol): void => {
        this.onSessionFound(sessionId, { cursorSessionProtocol: protocol });
    };
}
