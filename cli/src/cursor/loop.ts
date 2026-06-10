import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { CursorSession } from './session';
import { cursorLocalLauncher } from './cursorLocalLauncher';
import { cursorRemoteLauncher } from './cursorRemoteLauncher';
import type { Metadata } from '@hapi/protocol/schemas';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { CursorPermissionMode } from '@hapi/protocol/types';

export type PermissionMode = CursorPermissionMode;

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
    cursorArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    model?: string;
    sessionMetadata?: Metadata | null;
    onSessionReady?: (session: CursorSession) => void;
}

export async function loop(opts: LoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';
    const session = new CursorSession({
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
        cursorArgs: opts.cursorArgs,
        model: opts.model,
        permissionMode: opts.permissionMode ?? 'default'
    });

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'cursor-loop',
        runLocal: cursorLocalLauncher,
        runRemote: (session) => cursorRemoteLauncher(session, opts.sessionMetadata),
        onSessionReady: opts.onSessionReady
    });
}
