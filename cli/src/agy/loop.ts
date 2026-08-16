import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { AgySession } from './session';
import { agyHeadlessDriver } from './headless/agyHeadlessDriver';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { AgyMode, PermissionMode } from './types';
import type { SessionEffort, SessionModel } from '@/api/types';

interface AgyLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
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
}

export async function agyLoop(opts: AgyLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'remote';
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
            logger.debug('[agy-loop] Local mode not supported; switching to remote');
            return 'switch';
        },
        runRemote: agyHeadlessDriver,
        onSessionReady: opts.onSessionReady
    });
}
