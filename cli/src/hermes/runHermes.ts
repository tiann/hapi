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
import type { PermissionMode } from '@hapi/protocol/types'
import type { AgentState } from '@/api/types'
import { HermesRemoteLauncher } from './hermesRemoteLauncher'
import { HermesSession } from './session'
import { hermesModeForPreference, type HermesMode } from './types'

export async function runHermes(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    resumeSessionId?: string
    /** Fresh machine-spawn stub (`--hapi-session-id`); adopt via bootstrapSession. */
    reservedSessionId?: string
    /** Spawn-time model override (opaque ACP config-option value). */
    model?: string
    /** Spawn-time permission mode (default / safe-yolo / yolo). */
    permissionMode?: PermissionMode
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
    // Three-state preference: undefined = nothing requested yet (ordinary
    // turns carry no model field), null = the picker's explicit "Default"
    // reset, string = a concrete model. Only the config RPC ever sets null.
    let currentModel: string | null | undefined = opts.model
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default'

    const syncSessionMode = () => {
        const active = sessionRef.current
        if (!active) return
        active.setModel(currentModel ?? null)
        active.setPermissionMode(currentPermissionMode)
        active.pushKeepAlive()
    }

    session.onUserMessage((message, localId) => {
        queue.push(
            formatMessageWithAttachments(message.content.text, message.content.attachments),
            hermesModeForPreference(currentModel, currentPermissionMode),
            localId
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    registerSessionConfigRpc({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'hermes',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'ignore',
        effortMode: 'ignore',
        onApply: (config) => {
            if (config.model !== undefined) currentModel = config.model
            if (config.permissionMode !== undefined) currentPermissionMode = config.permissionMode
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
            currentModel = model ?? undefined
            syncSessionMode()
        },
        onConfigDiscovered: (model) => {
            // Discovery reporting no model leaves the preference unset — an
            // ordinary turn must not turn into a "Default" reset request.
            currentModel = model ?? undefined
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
