import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { AgySession } from './session';
import { agyLocalLauncher } from './agyLocalLauncher';
import { agyRemoteLauncher } from './agyRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { AgyMode, PermissionMode } from './types';

interface AgyLoopOptions {
    additionalDirectories?: string[];
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<AgyMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    logFile?: string;
    printTimeout?: string;
    resumeSessionId?: string;
    onSessionReady?: (session: AgySession) => void;
}

export async function agyLoop(opts: AgyLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new AgySession({
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

    const getCurrentModel = (): string | undefined => {
        const sessionModel = session.getModel();
        return sessionModel != null ? sessionModel : opts.model;
    };

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'agy-loop',
        runLocal: (instance) => agyLocalLauncher(instance, {
            additionalDirectories: opts.additionalDirectories,
            logFile: opts.logFile,
            model: getCurrentModel()
        }),
        runRemote: (instance) => agyRemoteLauncher(instance, {
            additionalDirectories: opts.additionalDirectories,
            logFile: opts.logFile,
            model: getCurrentModel(),
            printTimeout: opts.printTimeout
        }),
        onSessionReady: opts.onSessionReady
    });
}
