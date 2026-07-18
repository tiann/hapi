import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { GrokSession } from './session';
import { grokLocalLauncher } from './grokLocalLauncher';
import { grokRemoteLauncher } from './grokRemoteLauncher';
import type { ApiClient, ApiSessionClient } from '@/lib';
import type { MessageQueue2 } from '@/utils/MessageQueue2';
import type { GrokMode, PermissionMode } from './types';

export async function grokLoop(opts: {
    path: string; startingMode: 'local' | 'remote'; startedBy: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void; messageQueue: MessageQueue2<GrokMode>;
    session: ApiSessionClient; api: ApiClient; permissionMode: PermissionMode;
    model?: string | null; effort?: string | null; resumeSessionId?: string;
    onSessionReady?: (session: GrokSession) => void;
}): Promise<void> {
    const session = new GrokSession({
        api: opts.api, client: opts.session, path: opts.path, logPath: logger.getLogPath(),
        sessionId: opts.resumeSessionId ?? null, messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange, mode: opts.startingMode, startedBy: opts.startedBy,
        startingMode: opts.startingMode, permissionMode: opts.permissionMode,
        model: opts.model, effort: opts.effort
    });
    await runLocalRemoteSession({
        session, startingMode: opts.startingMode, logTag: 'grok-loop',
        runLocal: grokLocalLauncher, runRemote: grokRemoteLauncher, onSessionReady: opts.onSessionReady
    });
}
