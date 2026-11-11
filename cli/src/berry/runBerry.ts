import { hashObject } from '@/utils/deterministicJson'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { registerLocalHandoffHandler } from '@/agent/localHandoff'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { logger } from '@/ui/logger'
import type { PermissionMode } from '@hapi/protocol/types'
import type { AgentState } from '@/api/types'
import { BerryRemoteLauncher } from './berryRemoteLauncher'
import { BerrySession } from './session'
import { berryModeForPreference, type BerryMode } from './types'
import { berryImageAttachmentsFor, formatBerryUserMessage } from './utils/berryPromptContent'

export async function runBerry(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    resumeSessionId?: string
    /** Fresh machine-spawn stub (`--hapi-session-id`); adopt via bootstrapSession. */
    reservedSessionId?: string
    /** Spawn-time model override (opaque ACP config-option value). */
    model?: string
    /** Spawn-time permission mode (default / read-only / safe-yolo / yolo). */
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
            flavor: 'berry',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'berry',
            startedBy,
            workingDirectory,
            agentState: initialState,
            reservedSessionId: opts.reservedSessionId,
            model: opts.model
        })
    const { api, session, sessionInfo } = bootstrap
    setControlledByUser(session, startingMode)

    const queue = new MessageQueue2<BerryMode>((mode) => hashObject(mode))
    const sessionRef: { current: BerrySession | null } = { current: null }
    const launcherRef: { current: BerryRemoteLauncher | null } = { current: null }
    // Three-state preference: undefined = nothing requested yet (ordinary
    // turns carry no model field), null = the picker's explicit "Default"
    // reset, string = a concrete model. Only the config RPC ever sets null.
    let currentModel: string | null | undefined = opts.model
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default'

    const syncSessionMode = () => {
        const active = sessionRef.current
        if (!active) return
        // Preserve the three-state model: `undefined` (no preference — e.g.
        // berry reported no catalog) must never collapse into
        // setModel(null). The keepalive runtime re-sends session.model every
        // 2s, so a null would land on the hub within seconds of spawn and
        // wipe the stored --model X off the session row — breaking later
        // resume (which re-applies the stored model). Only an actual value —
        // an explicit "Default" reset (null) or a concrete model — is worth
        // communicating; the opts.model seed already reached the hub through
        // bootstrap and stays on the session untouched.
        if (currentModel !== undefined) {
            active.setModel(currentModel)
        }
        active.setPermissionMode(currentPermissionMode)
        active.pushKeepAlive()
    }

    session.onUserMessage((message, localId) => {
        queue.push(
            // Non-image attachments keep the @path text form; inline-capable
            // images ride the mode and become ACP image content blocks at
            // prompt time (utils/berryPromptContent).
            formatBerryUserMessage(message.content.text, message.content.attachments),
            {
                ...berryModeForPreference(currentModel, currentPermissionMode),
                ...berryImageAttachmentsFor(message.content.attachments)
            },
            localId
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    registerSessionConfigRpc({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'berry',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'ignore',
        effortMode: 'ignore',
        onApply: (config) => {
            if (config.model !== undefined) currentModel = config.model
            if (config.permissionMode !== undefined) currentPermissionMode = config.permissionMode
        },
        onAfterApply: () => {
            syncSessionMode()
            // Mid-session mode switches take effect on the very next
            // request_permission (the bridge reads the live mode); applyModeNow
            // only mirrors the new mode into the terminal log immediately
            // instead of at the next turn boundary.
            void launcherRef.current?.applyModeNow?.()
        }
    })

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'berry',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive(),
        onBeforeClose: () => launcherRef.current?.kill()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session)
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle)

    const berrySession = new BerrySession({
        api,
        client: session,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        model: opts.model,
        permissionMode: currentPermissionMode,
        sessionId: opts.resumeSessionId ?? sessionInfo.metadata?.berrySessionId,
        messageQueue: queue,
        onModeChange: () => {},
        startedBy
    })
    const launcher = new BerryRemoteLauncher(berrySession, {
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
    sessionRef.current = berrySession
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
