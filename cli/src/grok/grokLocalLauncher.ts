import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher'
import { grokLocal } from './grokLocal'
import type { GrokSession } from './session'
import type { PermissionMode } from './types'

export async function grokLocalLauncher(
    session: GrokSession,
    opts: { model?: string; effort?: string }
): Promise<'switch' | 'exit'> {
    const launcher = new BaseLocalLauncher({
        label: 'grok-local',
        failureLabel: 'Local Grok process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            if (!session.sessionId) {
                throw new Error('Grok session id is missing')
            }
            const resume = session.shouldResumeNativeSession()
            session.markNativeSessionStarted()
            await grokLocal({
                path: session.path,
                sessionId: session.sessionId,
                resume,
                abort: abortSignal,
                model: opts.model,
                effort: opts.effort,
                permissionMode: session.getPermissionMode() as PermissionMode | undefined
            })
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message })
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason)
        }
    })

    return await launcher.run()
}
