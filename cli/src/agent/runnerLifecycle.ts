import type { ApiSessionClient } from '@/api/apiSession'
import type { SessionEndReason } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import { restoreTerminalState } from '@/ui/terminalState'

type RunnerLifecycleOptions = {
    session: ApiSessionClient
    logTag: string
    stopKeepAlive?: () => void
    onBeforeClose?: () => Promise<void> | void
    onAfterClose?: () => Promise<void> | void
}

export type RunnerLifecycle = {
    setExitCode: (code: number) => void
    setArchiveReason: (reason: string) => void
    setSessionEndReason: (reason: SessionEndReason) => void
    markCrash: (error: unknown) => void
    cleanup: () => Promise<void>
    cleanupAndExit: (codeOverride?: number) => Promise<void>
    registerProcessHandlers: () => void
}

export function createRunnerLifecycle(options: RunnerLifecycleOptions): RunnerLifecycle {
    let exitCode = 0
    let archiveReason = 'User terminated'
    let sessionEndReason: SessionEndReason = 'terminated'
    let cleanupStarted = false
    let cleanupPromise: Promise<void> | null = null

    const logPrefix = `[${options.logTag}]`

    const archiveAndClose = async () => {
        options.session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason
        }))

        options.session.sendSessionDeath(sessionEndReason)
        await options.session.flush()
        await options.session.close()
    }

    const cleanup = async () => {
        if (cleanupPromise) {
            return cleanupPromise
        }

        cleanupStarted = true
        cleanupPromise = (async () => {
            logger.debug(`${logPrefix} Cleanup start`)
            restoreTerminalState()

            try {
                options.stopKeepAlive?.()
                await options.onBeforeClose?.()
                await archiveAndClose()
                logger.debug(`${logPrefix} Cleanup complete`)
            } finally {
                try {
                    await options.onAfterClose?.()
                } catch (error) {
                    logger.debug(`${logPrefix} Error during post-cleanup:`, error)
                }
            }
        })()

        return cleanupPromise
    }

    const cleanupAndExit = async (codeOverride?: number) => {
        if (codeOverride !== undefined) {
            exitCode = codeOverride
        }

        try {
            await cleanup()
            process.exit(exitCode)
        } catch (error) {
            logger.debug(`${logPrefix} Error during cleanup:`, error)
            process.exit(1)
        }
    }

    const setExitCode = (code: number) => {
        exitCode = code
    }

    const setArchiveReason = (reason: string) => {
        archiveReason = reason
    }

    const setSessionEndReason = (reason: SessionEndReason) => {
        sessionEndReason = reason
    }

    const markCrash = (error: unknown) => {
        logger.debug(`${logPrefix} Unhandled error:`, error)
        exitCode = 1
        archiveReason = 'Session crashed'
        sessionEndReason = 'error'
    }

    const registerProcessHandlers = () => {
        process.on('SIGTERM', () => {
            void cleanupAndExit()
        })

        process.on('SIGINT', () => {
            void cleanupAndExit()
        })

        process.on('uncaughtException', (error) => {
            markCrash(error)
            void cleanupAndExit(1)
        })

        process.on('unhandledRejection', (reason) => {
            markCrash(reason)
            void cleanupAndExit(1)
        })
    }

    return {
        setExitCode,
        setArchiveReason,
        setSessionEndReason,
        markCrash,
        cleanup,
        cleanupAndExit,
        registerProcessHandlers
    }
}

export function setControlledByUser(session: ApiSessionClient, mode: 'local' | 'remote'): void {
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: mode === 'local'
    }))
}

export function createModeChangeHandler(session: ApiSessionClient): (mode: 'local' | 'remote') => void {
    return (mode) => {
        session.sendSessionEvent({ type: 'switch', mode })
        setControlledByUser(session, mode)
    }
}
