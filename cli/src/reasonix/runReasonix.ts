import { logger } from '@/ui/logger'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { hashObject } from '@/utils/deterministicJson'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { AgentState } from '@/api/types'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { reasonixLoop } from './loop'
import type { ReasonixMode, PermissionMode } from './types'
import type { ReasonixLiveConfig } from './loop'

export async function runReasonix(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    permissionModeExplicit?: boolean
    model?: string
    effort?: string
    resumeSessionId?: string
    existingSessionId?: string
    sessionGeneration?: string
    workingDirectory?: string
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    const startingMode = 'remote' as const
    if (opts.startingMode === 'local') {
        logger.debug('[reasonix] Local mode requested; forcing remote ACP mode')
    }

    // Reject direct invalid overrides before creating/attaching a HAPI row.
    // The command parser normally performs this check, but API callers and
    // runner integrations can invoke runReasonix directly.
    if (opts.permissionModeExplicit === true) {
        const parsed = PermissionModeSchema.safeParse(opts.permissionMode)
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'reasonix')) {
            throw new Error(`Invalid Reasonix permission mode: ${opts.permissionMode ?? '(missing)'}`)
        }
    }

    const initialState: AgentState = { controlledByUser: false }
    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'reasonix',
            startedBy,
            workingDirectory,
            sessionGeneration: opts.sessionGeneration,
            metadataOverrides: { capabilities: { terminal: false } }
        })
        : await bootstrapSession({
            flavor: 'reasonix',
            startedBy,
            workingDirectory,
            agentState: initialState,
            // Do not persist CLI requests until ACP confirms them. Reasonix
            // advertises provider-specific model/effort values; an invalid
            // request must not make the HAPI row claim a value the backend
            // rejected during session setup.
            model: undefined,
            effort: undefined,
            sessionGeneration: opts.sessionGeneration,
            metadataOverrides: { capabilities: { terminal: false } }
        })
    const { api, session } = bootstrap
    setControlledByUser(session, startingMode)

    // HAPI's permissionMode is only a lossy projection of Reasonix's native
    // collaboration and approval axes. A routine resume must let ACP restore
    // those axes; only an explicit CLI/web override is a request to mutate
    // them. In particular, do not replay the persisted HAPI `default` value
    // over a native plan/goal session before `session/resume` reports state.
    const requestedPermissionMode = opts.permissionModeExplicit === true
        ? opts.permissionMode
        : undefined
    let currentPermissionMode: PermissionMode = requestedPermissionMode ?? 'default'

    // Validate before registering timers, process handlers, or RPC handlers.
    // Direct callers can bypass the command parser, so invalid values must not
    // leave a partially bootstrapped session behind.
    const parsedPermission = PermissionModeSchema.safeParse(currentPermissionMode)
    if (!parsedPermission.success || !isPermissionModeAllowedForFlavor(parsedPermission.data, 'reasonix')) {
        throw new Error(`Invalid Reasonix permission mode: ${currentPermissionMode}`)
    }
    // `undefined` means ACP has not advertised a value yet. Keep that
    // sentinel distinct from `null`, which is an explicit reset requested by
    // the session-config RPC. Otherwise a message queued during ACP startup
    // can reset a just-applied --model/--effort override back to defaults.
    let currentModel: string | null | undefined = undefined
    let currentEffort: string | null | undefined = undefined
    let permissionModeOverride = opts.permissionModeExplicit === true
    // A resumed ACP session owns the initial permission state. Keep the local
    // `default` fallback out of keepalive metadata until the launcher has
    // discovered that native state. Fresh sessions always start in Normal +
    // Ask, so their fallback is safe to publish immediately.
    let permissionModeReady = requestedPermissionMode !== undefined || opts.resumeSessionId === undefined
    let backendConfigReady = false
    let applyLiveConfig: ((config: ReasonixLiveConfig) => Promise<ReasonixLiveConfig>) | null = null
    const queue = new MessageQueue2<ReasonixMode>((mode) => hashObject(mode))
    const sessionRef: { current: import('./session').ReasonixSession | null } = { current: null }

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'reasonix',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle)

    const syncSessionMode = () => {
        const active = sessionRef.current
        if (!active) return
        if (permissionModeReady) active.setPermissionMode(currentPermissionMode)
        // Before ACP has returned config state, keep model/effort unset in
        // keepalive metadata. The launcher will call onConfigDiscovered only
        // after requested values have been accepted (or rolled back).
        if (backendConfigReady) {
            active.setModel(currentModel ?? null)
            active.setEffort(currentEffort ?? null)
        }
        active.pushKeepAlive()
    }

    session.onUserMessage((message, localId) => {
        queue.push(formatMessageWithAttachments(message.content.text, message.content.attachments), {
            permissionMode: permissionModeOverride ? currentPermissionMode : undefined,
            model: backendConfigReady ? currentModel : (opts.model ?? undefined),
            effort: backendConfigReady ? currentEffort : (opts.effort ?? undefined)
        }, localId)
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    registerSessionConfigRpc<PermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'reasonix',
        modelMode: 'nullable',
        effortMode: 'nullable',
        modelReasoningEffortMode: 'ignore',
        onApply: async (config) => {
            if (!applyLiveConfig) {
                throw new Error('Reasonix session is still initializing; try again shortly')
            }
            const confirmed = await applyLiveConfig(config)
            // The launcher returns a complete runtime snapshot after any
            // config change. Only a permissionMode key present in the request
            // is an operator override; a model/effort response must not turn
            // the lossy HAPI projection into an override that resets native
            // Reasonix goal/plan state on the next prompt.
            if (config.permissionMode !== undefined && confirmed.permissionMode !== undefined) {
                permissionModeOverride = true
                currentPermissionMode = confirmed.permissionMode
            }
            if (confirmed.model !== undefined) currentModel = confirmed.model
            if (confirmed.effort !== undefined) currentEffort = confirmed.effort
            return confirmed
        },
        onAfterApply: syncSessionMode,
        appliedFallback: () => ({ permissionMode: currentPermissionMode, model: currentModel, effort: currentEffort })
    })

    let crashed = false
    try {
        await reasonixLoop({
            path: workingDirectory,
            startedBy,
            onModeChange: createModeChangeHandler(session),
            messageQueue: queue,
            session,
            api,
            permissionMode: requestedPermissionMode,
            // Keep requested CLI values separate from the confirmed runtime
            // values above. The launcher applies these through ACP and only
            // reports them back via onConfigDiscovered after the agent accepts
            // (or rejects/rolls back) them.
            model: opts.model ?? null,
            effort: opts.effort ?? null,
            resumeSessionId: opts.resumeSessionId,
            permissionModeExplicit: opts.permissionModeExplicit === true,
            onSessionReady: (instance) => {
                sessionRef.current = instance
                syncSessionMode()
            },
            onConfigDiscovered: (config) => {
                currentModel = config.model
                currentEffort = config.effort
                backendConfigReady = true
                syncSessionMode()
            },
            onPermissionModeDiscovered: (mode) => {
                currentPermissionMode = mode
                permissionModeReady = true
                syncSessionMode()
            },
            onConfigApplyReady: (apply) => {
                applyLiveConfig = apply
            },
            onModelRollback: (model) => {
                currentModel = model
                syncSessionMode()
            },
            onEffortRollback: (effort) => {
                currentEffort = effort
                syncSessionMode()
            },
            onPermissionRollback: (permissionMode) => {
                currentPermissionMode = permissionMode
                permissionModeReady = true
                syncSessionMode()
            }
        })
    } catch (error) {
        crashed = true
        lifecycle.markCrash(error)
        logger.debug('[reasonix] Loop error:', error)
    } finally {
        if (!crashed) lifecycle.setSessionEndReason('completed')
        await lifecycle.cleanupAndExit()
    }
}
