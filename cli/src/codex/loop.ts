import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { CodexSession } from './session';
import { codexLocalLauncher } from './codexLocalLauncher';
import { codexRemoteLauncher } from './codexRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { CodexCliOverrides } from './utils/codexCliOverrides';
import type { CodexPermissionMode } from '@hapi/protocol/types';

export type PermissionMode = CodexPermissionMode;

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
}

interface LoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<EnhancedMode>;
    session: ApiSessionClient;
    api: ApiClient;
    codexArgs?: string[];
    codexCliOverrides?: CodexCliOverrides;
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    onSessionReady?: (session: CodexSession) => void;
}

export async function loop(opts: LoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';
    const session = new CodexSession({
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
        codexArgs: opts.codexArgs,
        codexCliOverrides: opts.codexCliOverrides,
        permissionMode: opts.permissionMode ?? 'default',
        resumeSessionId: opts.resumeSessionId
    });

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'codex-loop',
        runLocal: codexLocalLauncher,
        runRemote: codexRemoteLauncher,
        onSessionReady: opts.onSessionReady
    });
}
