import { logger } from '@/ui/logger'
import { grokLoop } from './loop'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { hashObject } from '@/utils/deterministicJson'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import type { AgentState } from '@/api/types'
import type { GrokSession } from './session'
import type { GrokMode, PermissionMode } from './types'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { registerLocalHandoffHandler } from '@/agent/localHandoff'
import {
    createModeChangeHandler,
    createRunnerLifecycle,
    setControlledByUser
} from '@/agent/runnerLifecycle'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'

export async function runGrok(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string
    effort?: string
    resumeSessionId?: string
    existingSessionId?: string
    workingDirectory?: string
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local')

    logger.debug(`[grok] Starting with options: startedBy=${startedBy}, startingMode=${startingMode}`)

    const initialState: AgentState = { controlledByUser: false }
    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'grok',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'grok',
            startedBy,
            workingDirectory,
            agentState: initialState,
            model: opts.model,
            effort: opts.effort
        })
    const { api, session, sessionInfo } = bootstrap
    setControlledByUser(session, startingMode)

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default'
    let currentModel = opts.model ?? null
    let currentEffort = opts.effort ?? null
    const queue = new MessageQueue2<GrokMode>((mode) => hashObject(mode))
    const sessionRef: { current: GrokSession | null } = { current: null }

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'grok',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle)
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle)

    const syncSessionMode = () => {
        const active = sessionRef.current
        if (!active) return
        active.setPermissionMode(currentPermissionMode)
        active.setModel(currentModel)
        active.setEffort(currentEffort)
        active.pushKeepAlive()
    }

    session.onUserMessage((message, localId) => {
        queue.push(
            formatMessageWithAttachments(message.content.text, message.content.attachments),
            {
                permissionMode: currentPermissionMode,
                model: currentModel ?? undefined,
                effort: currentEffort ?? undefined
            },
            localId
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    registerSessionConfigRpc<PermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'grok',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'ignore',
        effortMode: 'nullable',
        onApply: (config) => {
            if (config.permissionMode !== undefined) {
                currentPermissionMode = config.permissionMode
            }
            if (config.model !== undefined) currentModel = config.model
            if (config.effort !== undefined) currentEffort = config.effort
        },
        onAfterApply: syncSessionMode,
        appliedFallback: () => ({ permissionMode: currentPermissionMode })
    })

    let crashed = false
    try {
        await grokLoop({
            path: workingDirectory,
            hapiSessionId: sessionInfo.id,
            startingMode,
            startedBy,
            messageQueue: queue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: opts.model,
            effort: opts.effort,
            resumeSessionId: opts.resumeSessionId,
            onModelRollback: (model) => {
                currentModel = model
            },
            onEffortRollback: (effort) => {
                currentEffort = effort
            },
            onPermissionModeRollback: (permissionMode) => {
                currentPermissionMode = permissionMode
            },
            onConfigDiscovered: (config) => {
                currentModel = config.model
                currentEffort = config.effort
                syncSessionMode()
            },
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionRef.current = instance
                syncSessionMode()
            }
        })
    } catch (error) {
        crashed = true
        lifecycle.markCrash(error)
        logger.debug('[grok] Loop error:', error)
    } finally {
        const localFailure = sessionRef.current?.localLaunchFailure
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1)
            lifecycle.setArchiveReason(`Local launch failed: ${localFailure.message.slice(0, 200)}`)
            lifecycle.setSessionEndReason('error')
        } else if (!crashed) {
            lifecycle.setSessionEndReason('completed')
        }
        await lifecycle.cleanupAndExit()
    }
}
