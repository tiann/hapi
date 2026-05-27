import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { KimiSession } from './session';
import { kimiLocalLauncher } from './kimiLocalLauncher';
import { kimiRemoteLauncher } from './kimiRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { KimiMode, PermissionMode } from './types';

interface KimiLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<KimiMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    resumeSessionId?: string;
    onSessionReady?: (session: KimiSession) => void;
}

export async function kimiLoop(opts: KimiLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new KimiSession({
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
        logTag: 'kimi-loop',
        runLocal: (instance) => kimiLocalLauncher(instance, {
            model: getCurrentModel()
        }),
        runRemote: (instance) => kimiRemoteLauncher(instance, {
            model: getCurrentModel()
        }),
        onSessionReady: opts.onSessionReady
    });
}
