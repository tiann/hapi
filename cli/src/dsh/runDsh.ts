import { hashObject } from '@/utils/deterministicJson'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { registerLocalHandoffHandler } from '@/agent/localHandoff'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { logger } from '@/ui/logger'
import type { AgentState } from '@/api/types'
import type { DshPermissionMode } from '@hapi/protocol/types'
import { DshRemoteLauncher } from './dshRemoteLauncher'
import { DshSession } from './session'
import { dshModeForPreference, type DshMode } from './types'

export async function runDsh(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    /** Fresh machine-spawn stub (`--hapi-session-id`); adopt via bootstrapSession. */
    reservedSessionId?: string
    /** Spawn-time model override (opaque ACP config-option value). */
    model?: string
    /** Native ACP session id from `--resume`; resumed via session/resume. */
    resumeSessionId?: string
    workingDirectory?: string
    permissionMode?: DshPermissionMode
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
            flavor: 'dsh',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'dsh',
            startedBy,
            workingDirectory,
            agentState: initialState,
            reservedSessionId: opts.reservedSessionId,
            model: opts.model
        })
    const { api, session } = bootstrap
    setControlledByUser(session, startingMode)

    const queue = new MessageQueue2<DshMode>((mode) => hashObject(mode))
    const sessionRef: { current: DshSession | null } = { current: null }
    const launcherRef: { current: DshRemoteLauncher | null } = { current: null }
    // Three-state preference: undefined = nothing requested yet (ordinary
    // turns carry no model field), null = the picker's explicit "Default"
    // reset, string = a concrete model. Only the config RPC ever sets null.
    let currentModel: string | null | undefined = opts.model

    const syncSessionMode = () => {
        const active = sessionRef.current
        if (!active) return
        active.setModel(currentModel ?? null)
        active.pushKeepAlive()
    }

    session.onUserMessage((message, localId) => {
        queue.push(
            formatMessageWithAttachments(message.content.text, message.content.attachments),
            dshModeForPreference(currentModel),
            localId
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    registerSessionConfigRpc({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'dsh',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'ignore',
        effortMode: 'ignore',
        onApply: (config) => {
            if (config.model !== undefined) currentModel = config.model
            if (config.permissionMode !== undefined) {
                sessionRef.current?.setPermissionMode(config.permissionMode)
            }
        },
        onAfterApply: () => {
            syncSessionMode()
            sessionRef.current?.pushKeepAlive()
        }
    })

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'dsh',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive(),
        onBeforeClose: () => launcherRef.current?.kill()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session)
    // `hapi resume` hands active sessions over via the HandoffLocal RPC before
    // dispatching locally; without this registration an active DSH resume fails
    // with an unregistered-method error instead of archiving the running copy.
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle)

    const dshSession = new DshSession({
        api,
        client: session,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        model: opts.model,
        sessionId: opts.resumeSessionId ?? bootstrap.metadata.dshSessionId ?? null,
        messageQueue: queue,
        onModeChange: () => {},
        startedBy,
        permissionMode: opts.permissionMode
    })
    const launcher = new DshRemoteLauncher(dshSession, {
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
    sessionRef.current = dshSession
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
