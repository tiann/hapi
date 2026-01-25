import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { GeminiSession } from './session';
import { geminiLocalLauncher } from './geminiLocalLauncher';
import { geminiRemoteLauncher } from './geminiRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { GeminiMode, PermissionMode } from './types';

interface GeminiLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<GeminiMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    hookSettingsPath?: string;
    allowedTools?: string[];
    onSessionReady?: (session: GeminiSession) => void;
    resumeSessionId?: string;
}

export async function geminiLoop(opts: GeminiLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new GeminiSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        permissionMode: opts.permissionMode ?? 'default',
        resumeSessionId: opts.resumeSessionId
    });

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'gemini-loop',
        runLocal: (instance) => geminiLocalLauncher(instance, {
            model: opts.model,
            allowedTools: opts.allowedTools,
            hookSettingsPath: opts.hookSettingsPath
        }),
        runRemote: (instance) => geminiRemoteLauncher(instance, {
            model: opts.model,
            hookSettingsPath: opts.hookSettingsPath
        }),
        onSessionReady: opts.onSessionReady
    });
}
