import { MessageQueue2 } from '@/utils/MessageQueue2'
import { logger } from '@/ui/logger'
import { ApiClient, ApiSessionClient } from '@/lib'
import { ReasonixSession } from './session'
import { reasonixRemoteLauncher } from './reasonixRemoteLauncher'
import type { ReasonixMode, PermissionMode } from './types'

export type ReasonixLiveConfig = {
    permissionMode?: PermissionMode
    model?: string | null
    effort?: string | null
}

export async function reasonixLoop(opts: {
    path: string
    startedBy: 'runner' | 'terminal'
    onModeChange: (mode: 'local' | 'remote') => void
    messageQueue: MessageQueue2<ReasonixMode>
    session: ApiSessionClient
    api: ApiClient
    permissionMode?: PermissionMode
    permissionModeExplicit?: boolean
    model?: string | null
    effort?: string | null
    resumeSessionId?: string
    onSessionReady?: (session: ReasonixSession) => void
    onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void
    onPermissionModeDiscovered?: (mode: PermissionMode) => void
    onConfigApplyReady?: (apply: (config: ReasonixLiveConfig) => Promise<ReasonixLiveConfig>) => void
    onModelRollback?: (model: string | null) => void
    onEffortRollback?: (effort: string | null) => void
    onPermissionRollback?: (mode: PermissionMode) => void
}): Promise<void> {
    const session = new ReasonixSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        logPath: logger.getLogPath(),
        sessionId: opts.resumeSessionId ?? null,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        startedBy: opts.startedBy,
        permissionMode: opts.permissionMode,
        model: null,
        effort: null
    })
    if (opts.resumeSessionId) session.onSessionFound(opts.resumeSessionId)
    opts.onSessionReady?.(session)
    await reasonixRemoteLauncher(session, {
        model: opts.model ?? undefined,
        effort: opts.effort ?? undefined,
        permissionModeExplicit: opts.permissionModeExplicit === true,
        resuming: opts.resumeSessionId !== undefined,
        onConfigDiscovered: opts.onConfigDiscovered,
        onPermissionModeDiscovered: opts.onPermissionModeDiscovered,
        onConfigApplyReady: opts.onConfigApplyReady,
        onModelRollback: opts.onModelRollback,
        onEffortRollback: opts.onEffortRollback,
        onPermissionRollback: opts.onPermissionRollback
    })
}
