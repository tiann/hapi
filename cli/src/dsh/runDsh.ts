import { hashObject } from '@/utils/deterministicJson'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { registerLocalHandoffHandler } from '@/agent/localHandoff'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { logger } from '@/ui/logger'
import type { AgentState, SessionPermissionMode } from '@/api/types'
import { DshRemoteLauncher } from './dshRemoteLauncher'
import { DshSession } from './session'
import { dshModeForPreference, type DshMode } from './types'
import { dshImageAttachmentsFor, formatDshUserMessage } from './utils/dshPromptContent'

export async function runDsh(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    resumeSessionId?: string
    /** Fresh machine-spawn stub (`--hapi-session-id`); adopt via bootstrapSession. */
    reservedSessionId?: string
    /** Spawn-time model override (opaque ACP config-option value). */
    model?: string
    /** Spawn-time reasoning-effort preference (off/low/high/max; dsh's
     *  `reasoning_effort` ACP config option, category thought_level). Seeded
     *  as the live preference so the first queued turn applies it through
     *  session/set_config_option; the "Default" reset maps null → '' like
     *  the in-chat picker. */
    modelReasoningEffort?: string
    /** Spawn-time permission mode — pinned into the child env as
     * DSH_PERMISSION_MODE (read-only / danger-full-access); dsh reads it only
     * at spawn and has no runtime mode RPC. */
    permissionMode?: string
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
            model: opts.model,
            modelReasoningEffort: opts.modelReasoningEffort
        })
    const { api, session, sessionInfo } = bootstrap
    setControlledByUser(session, startingMode)

    const queue = new MessageQueue2<DshMode>((mode) => hashObject(mode))
    const sessionRef: { current: DshSession | null } = { current: null }
    const launcherRef: { current: DshRemoteLauncher | null } = { current: null }
    // Three-state preference: undefined = nothing requested yet (ordinary
    // turns carry no model field), null = the picker's explicit "Default"
    // reset, string = a concrete model. Only the config RPC ever sets null.
    let currentModel: string | null | undefined = opts.model
    // Reasoning-effort preference (undefined until the picker is used; null =
    // the "Default" reset, mapped to DSH's '' = Provider default). A spawn-time
    // --model-reasoning-effort seeds it so the first queued turn applies it
    // through session/set_config_option.
    let currentReasoningEffort: string | null | undefined = opts.modelReasoningEffort

    const syncSessionMode = () => {
        const active = sessionRef.current
        if (!active) return
        active.setModel(currentModel ?? null)
        // Mirror the reasoning-effort tracking into the keepalive runtime so
        // the hub picker always shows the live preference (in particular the
        // corrected value after a rollback below).
        active.setModelReasoningEffort(currentReasoningEffort)
        active.pushKeepAlive()
    }

    session.onUserMessage((message, localId) => {
        queue.push(
            // Non-image attachments keep the @path text form; inline-capable
            // images ride the mode and become ACP image content blocks at
            // prompt time (utils/dshPromptContent).
            formatDshUserMessage(message.content.text, message.content.attachments),
            {
                ...dshModeForPreference(currentModel),
                ...(currentReasoningEffort !== undefined ? { modelReasoningEffort: currentReasoningEffort } : {}),
                ...dshImageAttachmentsFor(message.content.attachments)
            },
            localId
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    registerSessionConfigRpc({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'dsh',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'nullable',
        effortMode: 'ignore',
        onApply: (config) => {
            if (config.model !== undefined) currentModel = config.model
            if (config.modelReasoningEffort !== undefined) currentReasoningEffort = config.modelReasoningEffort
        },
        onAfterApply: syncSessionMode
    })

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'dsh',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive(),
        onBeforeClose: () => launcherRef.current?.kill()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session)
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle)

    const dshSession = new DshSession({
        api,
        client: session,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        model: opts.model,
        permissionMode: opts.permissionMode as SessionPermissionMode | undefined,
        sessionId: opts.resumeSessionId ?? sessionInfo.metadata?.dshSessionId,
        messageQueue: queue,
        onModeChange: () => {},
        startedBy
    })
    const launcher = new DshRemoteLauncher(dshSession, {
        model: opts.model,
        // Spawn-time sandbox preset only: read-only pins
        // DSH_PERMISSION_MODE=read-only and yolo danger-full-access on the
        // child env; default/safe-yolo leave it unset (server default
        // workspace-write). Mid-session switches stay HAPI-side auto-approval
        // — dsh exposes no runtime mode RPC.
        permissionMode: opts.permissionMode,
        onModelRollback: (model) => {
            currentModel = model ?? undefined
            syncSessionMode()
        },
        onEffortRollback: (effort) => {
            // A failed effort switch never took on the dsh side: track what
            // the launcher really runs with (mirror of the model rollback
            // path above). undefined = nothing tracked, and it must STAY
            // undefined: normalizing it to null would put an explicit
            // "Default" on every later turn and re-fail the switch each time.
            // The picker's failed pick is cleared once, right here — this
            // keepalive writes null (which overwrites the hub value) while
            // later keepalives carry no effort opinion at all.
            currentReasoningEffort = effort
            const active = sessionRef.current
            if (!active) return
            active.setModelReasoningEffort(effort ?? null)
            active.pushKeepAlive()
        },
        onEffortDiscovered: (effort) => {
            // The session came up on a level nobody picked (dsh always runs on
            // some level): show it instead of a "Default" dsh does not have.
            currentReasoningEffort = effort
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
