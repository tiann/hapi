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
    modelReasoningEffort?: string | null;
    resumeSessionId?: string;
    hookServer: OpencodeHookServer;
    hookUrl: string;
    onSessionReady?: (session: OpencodeSession) => void;
    onReasoningEffortRollback?: (effort: string | null) => void;
    onCompactAvailabilityChange?: (available: boolean) => void;
    // Consumes (delete-and-return) whether the given localId was cancelled
    // after already being dequeued — needed because a queued /compact can
    // still be running (its REST call can take minutes) by the time a
    // cancel arrives, well past the point `messageQueue.cancelByLocalId`
    // can do anything about it.
    isLocalIdCancelled?: (localId: string) => boolean;
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
        permissionMode: opts.permissionMode ?? 'default',
        modelReasoningEffort: opts.modelReasoningEffort
    });

    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'opencode-loop',
        runLocal: (instance) => {
            // /compact only exists in remote mode (it needs the ACP backend +
            // internal HTTP baseUrl that only opencodeRemoteLauncher owns).
            // Reset availability on every entry into local mode — including
            // a remote->local handoff mid-session — so a stale "available"
            // flag from the just-disposed remote launcher can't survive the
            // switch and let /compact try to run against state that no
            // longer exists.
            opts.onCompactAvailabilityChange?.(false);
            return opencodeLocalLauncher(instance, {
                hookServer: opts.hookServer,
                hookUrl: opts.hookUrl
            });
        },
        runRemote: (instance) => opencodeRemoteLauncher(instance, {
            onReasoningEffortRollback: opts.onReasoningEffortRollback,
            onCompactAvailabilityChange: opts.onCompactAvailabilityChange,
            isLocalIdCancelled: opts.isLocalIdCancelled
        }),
        onSessionReady: opts.onSessionReady
    });
}
