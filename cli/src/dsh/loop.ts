import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { DshSession } from './session';
import { dshLocalLauncher } from './dshLocalLauncher';
import { dshRemoteLauncher } from './dshRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { DshMode, PermissionMode } from './types';

interface DshLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<DshMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string;
    preset?: string;
    resumeSessionId?: string;
    onSessionReady?: (session: DshSession) => void;
}

export async function dshLoop(opts: DshLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new DshSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.resumeSessionId ?? null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        permissionMode: opts.permissionMode ?? 'default'
    });

    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    const getCurrentModel = (): string | undefined => {
        const sessionModel = session.getModel();
        return sessionModel != null ? sessionModel : opts.model;
    };

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'dsh-loop',
        runLocal: (instance) => dshLocalLauncher(instance, {
            model: getCurrentModel()
        }),
        runRemote: (instance) => dshRemoteLauncher(instance, {
            model: getCurrentModel(),
            effort: opts.effort,
            preset: opts.preset
        }),
        onSessionReady: opts.onSessionReady
    });
}