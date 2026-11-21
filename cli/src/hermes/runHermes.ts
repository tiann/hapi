import { hashObject } from '@/utils/deterministicJson'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { registerLocalHandoffHandler } from '@/agent/localHandoff'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { logger } from '@/ui/logger'
import type { AgentState } from '@/api/types'
import type { HermesPermissionMode } from '@hapi/protocol/modes'
import { HermesRemoteLauncher } from './hermesRemoteLauncher'
import { HermesSession } from './session'
import { hermesModeForPreference, type HermesMode } from './types'

export async function runHermes(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    resumeSessionId?: string
    reservedSessionId?: string
    permissionMode?: HermesPermissionMode
    model?: string
    workingDirectory?: string
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    const startingMode = 'remote' as const
    const initialState: AgentState = {
        controlledByUser: false,
        startingMode
    }

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'hermes',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'hermes',
            startedBy,
            workingDirectory,
            agentState: initialState,
            reservedSessionId: opts.reservedSessionId,
            model: opts.model
        })
    const { api, session, sessionInfo } = bootstrap
    setControlledByUser(session, startingMode)

    const queue = new MessageQueue2<HermesMode>((mode) => hashObject(mode))
    const sessionRef: { current: HermesSession | null } = { current: null }
    const launcherRef: { current: HermesRemoteLauncher | null } = { current: null }
    let currentPermissionMode: HermesPermissionMode = opts.permissionMode ?? 'default'
    let currentModel: string | null | undefined = opts.model

    const syncSessionMode = () => {
        const active = sessionRef.current
        if (!active) return
        active.setPermissionMode(currentPermissionMode)
        active.setModel(currentModel ?? null)
        active.pushKeepAlive()
    }

    session.onUserMessage((message, localId) => {
        queue.push(
            formatMessageWithAttachments(message.content.text, message.content.attachments),
            hermesModeForPreference(currentPermissionMode, currentModel),
            localId
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    registerSessionConfigRpc<HermesPermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'hermes',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'ignore',
        effortMode: 'ignore',
        onApply: (config) => {
            if (config.permissionMode !== undefined) {
                currentPermissionMode = config.permissionMode
            }
            if (config.model !== undefined) {
                currentModel = config.model
            }
        },
        onAfterApply: syncSessionMode
    })

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'hermes',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive(),
        onBeforeClose: () => launcherRef.current?.kill()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session)
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle)

    const hermesSession = new HermesSession({
        api,
        client: session,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        model: opts.model,
        permissionMode: currentPermissionMode,
        sessionId: opts.resumeSessionId ?? sessionInfo.metadata?.hermesSessionId,
        messageQueue: queue,
        onModeChange: () => {},
        startedBy
    })
    const launcher = new HermesRemoteLauncher(hermesSession, {
        model: opts.model,
        onModelRollback: (model) => {
            currentModel = model ?? null
            syncSessionMode()
        },
        onConfigDiscovered: (model) => {
            currentModel = model ?? null
            syncSessionMode()
        }
    })
    sessionRef.current = hermesSession
    launcherRef.current = launcher

    let crashed = false
    try {
        await launcher.launch()
    } catch (error) {
        crashed = true
        lifecycle.markCrash(error)
    } finally {
        if (!crashed) lifecycle.setSessionEndReason('completed')
        await lifecycle.cleanupAndExit()
    }
}
