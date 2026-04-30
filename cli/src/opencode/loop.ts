import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { OpencodeSession } from './session';
import { opencodeLocalLauncher } from './opencodeLocalLauncher';
import { opencodeRemoteLauncher } from './opencodeRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { OpencodeMode, PermissionMode } from './types';
import type { OpencodeHookServer } from './utils/startOpencodeHookServer';

interface OpencodeLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<OpencodeMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    resumeSessionId?: string;
    hookServer: OpencodeHookServer;
    hookUrl: string;
    onSessionReady?: (session: OpencodeSession) => void;
}

export async function opencodeLoop(opts: OpencodeLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new OpencodeSession({
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

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'opencode-loop',
        runLocal: (instance) => opencodeLocalLauncher(instance, {
            hookServer: opts.hookServer,
            hookUrl: opts.hookUrl
        }),
        runRemote: (instance) => opencodeRemoteLauncher(instance),
        onSessionReady: opts.onSessionReady
    });
}
