import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { CopilotSession } from './session';
import { copilotLocalLauncher } from './copilotLocalLauncher';
import { copilotRemoteLauncher } from './copilotRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { CopilotAgentMode } from '@hapi/protocol';
import type { CopilotMode, PermissionMode } from './types';

interface CopilotLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<CopilotMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    copilotAgentMode?: CopilotAgentMode;
    resumeSessionId?: string;
    onSessionReady?: (session: CopilotSession) => void;
    onModelRollback?: (model: string | null) => void;
}

export async function copilotLoop(opts: CopilotLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new CopilotSession({
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
        permissionMode: opts.permissionMode ?? 'default',
        agentMode: opts.copilotAgentMode ?? 'interactive'
    });

    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    const getCurrentModel = (): string | undefined => session.getModel() ?? undefined;

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'copilot-loop',
        runLocal: (instance) => copilotLocalLauncher(instance, {
            model: getCurrentModel()
        }),
        runRemote: (instance) => copilotRemoteLauncher(instance, {
            model: getCurrentModel(),
            onModelRollback: opts.onModelRollback
        }),
        onSessionReady: opts.onSessionReady
    });
}
