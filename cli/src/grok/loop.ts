import { MessageQueue2 } from '@/utils/MessageQueue2'
import { logger } from '@/ui/logger'
import { runLocalRemoteSession } from '@/agent/loopBase'
import { GrokSession } from './session'
import { grokLocalLauncher } from './grokLocalLauncher'
import { grokRemoteLauncher } from './grokRemoteLauncher'
import { ApiClient, ApiSessionClient } from '@/lib'
import type { GrokMode, PermissionMode } from './types'

interface GrokLoopOptions {
    path: string
    hapiSessionId: string
    startingMode: 'local' | 'remote'
    startedBy: 'runner' | 'terminal'
    onModeChange: (mode: 'local' | 'remote') => void
    messageQueue: MessageQueue2<GrokMode>
    session: ApiSessionClient
    api: ApiClient
    permissionMode: PermissionMode
    model?: string
    effort?: string
    resumeSessionId?: string
    onSessionReady?: (session: GrokSession) => void
    onModelRollback?: (model: string | null) => void
    onEffortRollback?: (effort: string | null) => void
    onPermissionModeRollback?: (mode: PermissionMode) => void
    onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void
}

export async function grokLoop(opts: GrokLoopOptions): Promise<void> {
    const session = new GrokSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.resumeSessionId ?? null,
        logPath: logger.getLogPath(),
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: opts.startingMode,
        startedBy: opts.startedBy,
        startingMode: opts.startingMode,
        permissionMode: opts.permissionMode,
        model: opts.model ?? null,
        effort: opts.effort ?? null
    })

    if (opts.resumeSessionId) {
        session.registerExistingNativeSession(opts.resumeSessionId)
    } else if (opts.startingMode === 'local') {
        // Grok accepts a caller-supplied UUID for a new native session. Reusing
        // the HAPI session UUID gives local mode a deterministic resume token
        // without scraping the fullscreen TUI.
        session.registerPendingNativeSession(opts.hapiSessionId)
    }

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'grok-loop',
        runLocal: (instance) => grokLocalLauncher(instance, {
            model: instance.getModel() ?? undefined,
            effort: instance.getEffort() ?? undefined
        }),
        runRemote: (instance) => grokRemoteLauncher(instance, {
            model: instance.getModel() ?? undefined,
            effort: instance.getEffort() ?? undefined,
            onModelRollback: opts.onModelRollback,
            onEffortRollback: opts.onEffortRollback,
            onPermissionModeRollback: opts.onPermissionModeRollback,
            onConfigDiscovered: opts.onConfigDiscovered
        }),
        onSessionReady: opts.onSessionReady
    })
}
