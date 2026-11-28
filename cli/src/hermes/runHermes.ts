import { BUILTIN_SLASH_COMMANDS } from '@hapi/protocol'
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

const HERMES_SLASH_COMMAND_NAMES = new Set<string>(
    BUILTIN_SLASH_COMMANDS.hermes.map((command) => command.name.toLowerCase())
)

export function isHermesSlashCommand(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return false
    const match = /^\/([a-z0-9_-]+)(?:\s|$)/i.exec(trimmed)
    if (!match) return false
    return HERMES_SLASH_COMMAND_NAMES.has(match[1].toLowerCase())
}

export function enqueueHermesUserMessage(
    queue: MessageQueue2<HermesMode>,
    rawText: string,
    formattedText: string,
    mode: HermesMode,
    localId?: string
): void {
    if (isHermesSlashCommand(rawText) || isHermesSlashCommand(formattedText)) {
        queue.pushIsolated(formattedText, mode, localId)
        return
    }
    queue.push(formattedText, mode, localId)
}

export function createHermesModelPreferenceController(
    initialModel: string | null | undefined,
    onSync: (model: string | null) => void
) {
    let currentModel: string | null | undefined = initialModel
    let revision = 0

    return {
        getModel(): string | null | undefined {
            return currentModel
        },
        getRevision(): number {
            return revision
        },
        applyConfigModel(model: string | null): number {
            currentModel = model
            revision += 1
            return revision
        },
        applyDiscoveredModel(model: string | null, expectedRevision?: number): boolean {
            if (expectedRevision !== undefined && expectedRevision !== revision) {
                return false
            }
            currentModel = model ?? null
            onSync(currentModel)
            return true
        },
        rollbackModel(model: string | null, expectedRevision?: number): boolean {
            if (expectedRevision !== undefined && expectedRevision !== revision) {
                return false
            }
            currentModel = model ?? null
            onSync(currentModel)
            return true
        },
        applyBackendModelChange(model: string | null): number {
            currentModel = model ?? null
            revision += 1
            onSync(currentModel)
            return revision
        }
    }
}

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

    const syncSessionMode = (modelOverride?: string | null) => {
        const active = sessionRef.current
        if (!active) return
        active.setPermissionMode(currentPermissionMode)
        active.setModel(modelOverride !== undefined ? modelOverride : (modelController.getModel() ?? null))
        active.pushKeepAlive()
    }
    const modelController = createHermesModelPreferenceController(
        opts.model,
        (model) => syncSessionMode(model)
    )

    session.onUserMessage((message, localId) => {
        enqueueHermesUserMessage(
            queue,
            message.content.text,
            formatMessageWithAttachments(message.content.text, message.content.attachments),
            hermesModeForPreference(currentPermissionMode, modelController.getModel(), modelController.getRevision()),
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
                modelController.applyConfigModel(config.model)
            }
        },
        onAfterApply: () => syncSessionMode()
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
        initialModelRevision: modelController.getRevision(),
        onModelRollback: (model, revision) => {
            modelController.rollbackModel(model, revision)
        },
        onConfigDiscovered: (model, revision) => {
            modelController.applyDiscoveredModel(model, revision)
        },
        onModelChanged: (model) => modelController.applyBackendModelChange(model)
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
