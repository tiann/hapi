import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteLoop } from '@/agent/loopBase';
import { CodexSession } from './session';
import { codexLocalLauncher } from './codexLocalLauncher';
import { codexRemoteLauncher } from './codexRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';

export type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
}

interface LoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<EnhancedMode>;
    session: ApiSessionClient;
    api: ApiClient;
    codexArgs?: string[];
    onSessionReady?: (session: CodexSession) => void;
}

export async function loop(opts: LoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const session = new CodexSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: opts.startingMode ?? 'local',
        codexArgs: opts.codexArgs
    });

    if (opts.onSessionReady) {
        opts.onSessionReady(session);
    }

    await runLocalRemoteLoop({
        session,
        startingMode: opts.startingMode,
        logTag: 'codex-loop',
        runLocal: codexLocalLauncher,
        runRemote: codexRemoteLauncher
    });
}
