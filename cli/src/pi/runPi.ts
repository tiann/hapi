import { logger } from '@/ui/logger'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { hashObject } from '@/utils/deterministicJson'
import { bootstrapSession } from '@/agent/sessionFactory'
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { PiSession } from './session'
import { PiLauncher } from './piLauncher'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import type { PiEnhancedMode, PiPermissionMode, PiThinkingLevel } from './piTypes'

export type RunPiOptions = {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: PiPermissionMode
    resumeSessionId?: string
    model?: string
    thinkingLevel?: PiThinkingLevel
}

export const runPi = async (options: RunPiOptions = {}): Promise<void> => {
    const workingDirectory = getInvokedCwd()
    const startedBy = options.startedBy ?? 'terminal'

    logger.debug(`[pi] Starting with options: startedBy=${startedBy}, startingMode=${options.startingMode}`)

    if (startedBy === 'runner' && options.startingMode === 'local') {
        logger.debug('[pi] Runner spawn requested with local mode; forcing remote mode')
        options.startingMode = 'remote'
    }

    const { api, session: apiSession } = await bootstrapSession({
        flavor: 'pi',
        startedBy,
        workingDirectory,
        model: options.model
    })

    const startingMode: 'local' | 'remote' = options.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local')

    setControlledByUser(apiSession, startingMode)

    const messageQueue = new MessageQueue2<PiEnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        thinkingLevel: mode.thinkingLevel
    }))

    let currentPermissionMode: PiPermissionMode = options.permissionMode ?? 'default'
    let currentModel = options.model
    let currentThinkingLevel = options.thinkingLevel

    const session = new PiSession({
        api,
        client: apiSession,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        sessionId: options.resumeSessionId ?? null,
        messageQueue,
        onModeChange: createModeChangeHandler(apiSession),
        mode: startingMode,
        startedBy,
        permissionMode: currentPermissionMode,
        thinkingLevel: currentThinkingLevel
    })

    const launcher = new PiLauncher(session)
    const lifecycle = createRunnerLifecycle({
        session: apiSession,
        logTag: 'pi',
        stopKeepAlive: () => session.stopKeepAlive()
    })

    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(apiSession.rpcHandlerManager, lifecycle.cleanupAndExit)

    const syncSessionMode = () => {
        session.setPermissionMode(currentPermissionMode)
        if (currentThinkingLevel) {
            session.setThinkingLevel(currentThinkingLevel)
        }
        logger.debug(`[pi] Synced session modes: permissionMode=${currentPermissionMode}, thinkingLevel=${currentThinkingLevel}`)
    }

    apiSession.rpcHandlerManager.registerHandler('abort', async () => {
        await launcher.abort()
    })

    apiSession.onUserMessage((message) => {
        const enhancedMode: PiEnhancedMode = {
            permissionMode: currentPermissionMode,
            model: currentModel,
            thinkingLevel: currentThinkingLevel
        }
        const formattedText = formatMessageWithAttachments(
            message.content.text,
            message.content.attachments
        )
        messageQueue.push(formattedText, enhancedMode)
    })

    apiSession.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload')
        }
        const config = payload as {
            permissionMode?: PiPermissionMode
            model?: string
            thinkingLevel?: PiThinkingLevel
        }

        if (config.permissionMode !== undefined) {
            currentPermissionMode = config.permissionMode
        }
        if (config.model !== undefined) {
            currentModel = config.model
        }
        if (config.thinkingLevel !== undefined) {
            currentThinkingLevel = config.thinkingLevel
        }

        syncSessionMode()

        return {
            applied: {
                permissionMode: currentPermissionMode,
                model: currentModel,
                thinkingLevel: currentThinkingLevel
            }
        }
    })

    try {
        await launcher.run()
    } catch (error) {
        lifecycle.markCrash(error)
        logger.debug('[pi] Launcher error:', error)
    } finally {
        await lifecycle.cleanupAndExit()
    }
}
