import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
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
        mode: opts.startingMode ?? 'local'
    });

    if (opts.onSessionReady) {
        opts.onSessionReady(session);
    }

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';

    while (true) {
        logger.debug(`[codex-loop] Iteration with mode: ${mode}`);

        if (mode === 'local') {
            const reason = await codexLocalLauncher(session);
            if (reason === 'exit') {
                return;
            }
            mode = 'remote';
            session.onModeChange(mode);
            continue;
        }

        if (mode === 'remote') {
            const reason = await codexRemoteLauncher(session);
            if (reason === 'exit') {
                return;
            }
            mode = 'local';
            session.onModeChange(mode);
            continue;
        }
    }
}
