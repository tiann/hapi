import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { AgySession } from './session';
import { agyPtyLauncher } from './agyPtyLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { AgyMode, PermissionMode } from './types';
import type { SessionEffort, SessionModel } from '@/api/types';
import type { AgyPermissionHandler } from './utils/agyPermissionHandler';
import type { AgyMcpServerEntry } from './utils/agyHookCarrier';

interface AgyLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote' | 'pty';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<AgyMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: SessionModel;
    effort?: SessionEffort;
    resumeSessionId?: string;
    onSessionReady?: (session: AgySession) => void;
    /** Additional workspace carrying the session-local .agents/hooks.json. */
    hookCarrierDir?: string;
    hookPort?: number;
    hookToken?: string;
    /** hooks.json contents for the with/without-PreInvocation carrier states (see AgySession's docstring). */
    hooksJsonWithPreInvocation?: string;
    hooksJsonWithoutPreInvocation?: string;
    /** MCP server entry needed to rebuild the carrier if it has to be recreated mid-session. */
    hookMcpServer?: AgyMcpServerEntry;
    /** PTY-mode permission bridge. */
    agyPermissionHandler?: AgyPermissionHandler | null;
}

export async function agyLoop(opts: AgyLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'pty';
    if (startingMode !== 'pty') throw new Error('AGY only supports PTY mode')
    const sessionMode: 'local' | 'remote' = 'remote';

    const session = new AgySession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.resumeSessionId ?? null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: sessionMode,
        startedBy,
        permissionMode: opts.permissionMode,
        model: opts.model,
        effort: opts.effort,
        hookCarrierDir: opts.hookCarrierDir,
        hookPort: opts.hookPort,
        hookToken: opts.hookToken,
        hooksJsonWithPreInvocation: opts.hooksJsonWithPreInvocation,
        hooksJsonWithoutPreInvocation: opts.hooksJsonWithoutPreInvocation,
        hookMcpServer: opts.hookMcpServer,
        agyPermissionHandler: opts.agyPermissionHandler,
    });

    // On resume, immediately persist the brain UUID into metadata so
    // inactiveSessionCanResume returns true from the first reconnect.
    // Mirrors geminiLoop's session.onSessionFound(resumeSessionId) pattern.
    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    await runLocalRemoteSession({
        session,
        startingMode,
        logTag: 'agy-loop',
        runLocal: async (s) => {
            logger.debug('[agy-loop] Local mode not supported; switching to PTY');
            return 'switch';
        },
        runRemote: async (s) => {
            logger.debug('[agy-loop] Remote mode not supported; switching to local');
            return 'switch';
        },
        runPty: agyPtyLauncher,
        onSessionReady: opts.onSessionReady
    });
}
