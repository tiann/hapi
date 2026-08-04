import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { AgyMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { SessionEffort, SessionModel } from '@/api/types';
import type { AgyPermissionHandler } from './utils/agyPermissionHandler';
import type { AgyMcpServerEntry } from './utils/agyHookCarrier';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class AgySession extends AgentSessionBase<AgyMode> {
    private liveModelHandler: ((model: SessionModel) => Promise<void>) | null = null;
    readonly startedBy: 'runner' | 'terminal';
    /**
     * Additional workspace carrying HAPI hooks without modifying HOME or the
     * project. Mutable (not readonly): agyPtyLauncher's respawn-reattach
     * cycle can rebuild the carrier at a NEW path (prepareAgyHookCarrier
     * always mkdtemps a fresh directory — it cannot reuse the old one) if the
     * original carrier vanished (e.g. /tmp's 30-day tmpfiles.d sweep on a
     * long-lived session), and must repoint this field so the next agy spawn
     * picks it up via --add-dir. See setHookCarrierDir.
     */
    hookCarrierDir: string | undefined;
    readonly hookPort: number | undefined;
    readonly hookToken: string | undefined;
    /**
     * hooks.json contents for the carrier's two PreInvocation states — with
     * the discovery hook registered, and without it. agyPtyLauncher swaps
     * between them via agyHookCarrier.ts's writeAgyHooksJsonAtomic, choosing
     * WITHOUT once the brain UUID is confirmed (agySessionId set — it fires
     * on every model call and is redundant once discovery has nothing left
     * to do) and WITH otherwise (still-undiscovered sessions, on every
     * launch including the first). Undefined outside PTY mode, where no
     * carrier exists.
     */
    readonly hooksJsonWithPreInvocation: string | undefined;
    readonly hooksJsonWithoutPreInvocation: string | undefined;
    /** MCP server entry needed to rebuild the carrier's HAPI plugin files if the carrier has to be recreated (see hookCarrierDir's docstring). */
    readonly hookMcpServer: AgyMcpServerEntry | undefined;
    /**
     * The PTY-mode permission bridge (null outside PTY mode). agyPtyLauncher
     * uses this to register agy's native `ask_question` as a pending request
     * (see AgyPermissionHandler.registerQuestionRequest) — agy never routes
     * ask_question through the PreToolUse hook that normally feeds this
     * handler, so the launcher must call it directly from the transcript scan.
     */
    readonly agyPermissionHandler: AgyPermissionHandler | null;
    localLaunchFailure: LocalLaunchFailure | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<AgyMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        permissionMode?: PermissionMode;
        model?: SessionModel;
        effort?: SessionEffort;
        hookCarrierDir?: string;
        hookPort?: number;
        hookToken?: string;
        hooksJsonWithPreInvocation?: string;
        hooksJsonWithoutPreInvocation?: string;
        hookMcpServer?: AgyMcpServerEntry;
        agyPermissionHandler?: AgyPermissionHandler | null;
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
            sessionLabel: 'AgySession',
            sessionIdLabel: 'Antigravity',
            applySessionIdToMetadata: (metadata, sessionId, extras) => ({
                ...metadata,
                agySessionId: sessionId,
                ...extras
            }),
            permissionMode: opts.permissionMode,
            model: opts.model,
            effort: opts.effort,
            acknowledgeMessagesOnDequeue: false
        });

        this.startedBy = opts.startedBy;
        this.hookCarrierDir = opts.hookCarrierDir;
        this.hookPort = opts.hookPort;
        this.hookToken = opts.hookToken;
        this.hooksJsonWithPreInvocation = opts.hooksJsonWithPreInvocation;
        this.hooksJsonWithoutPreInvocation = opts.hooksJsonWithoutPreInvocation;
        this.hookMcpServer = opts.hookMcpServer;
        this.agyPermissionHandler = opts.agyPermissionHandler ?? null;
        this.permissionMode = opts.permissionMode;
        this.model = opts.model;
        this.effort = opts.effort;
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    /** Repoint hookCarrierDir after agyPtyLauncher rebuilds the carrier at a new path (see the field's docstring). */
    setHookCarrierDir = (carrierDir: string): void => {
        this.hookCarrierDir = carrierDir;
    };

    setModel = (model: SessionModel): void => {
        this.model = model;
    };

    setLiveModelHandler = (handler: ((model: SessionModel) => Promise<void>) | null): void => {
        this.liveModelHandler = handler;
    };

    applyLiveModel = async (model: SessionModel): Promise<void> => {
        if (!this.liveModelHandler) throw new Error('AGY PTY is not ready for a live model change');
        await this.liveModelHandler(model);
    };

    setEffort = (effort: SessionEffort): void => {
        this.effort = effort;
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
}
