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
    hasExplicitSessionEndReason: () => boolean
    markCrash: (error: unknown) => void
    cleanup: () => Promise<void>
    cleanupAndExit: (codeOverride?: number) => Promise<void>
    registerProcessHandlers: () => void
}

export function createRunnerLifecycle(options: RunnerLifecycleOptions): RunnerLifecycle {
    let exitCode = 0
    // tiann/hapi#914: default reason is 'Hub restart' (parent-driven SIGTERM
    // is the most common non-user cause). Genuine user actions (clicking
    // Archive in the web UI, or Ctrl-C in a local terminal) explicitly
    // reassign this via `setArchiveReason` BEFORE `cleanupAndExit` runs:
    //   - KillSession RPC handler  → 'User terminated' (see registerKillSessionHandler)
    //   - SIGINT handler           → 'User terminated' (Ctrl-C in local terminal)
    //   - uncaughtException/Reject → 'Session crashed' (via markCrash)
    // Out-of-band SIGTERM (hub-restart cascade, `kill <pid>` from host) keeps
    // the default and is correctly labelled 'Hub restart' on the audit trail.
    let archiveReason = 'Hub restart'
    let sessionEndReason: SessionEndReason = 'terminated'
    let sessionEndReasonExplicit = false
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
        sessionEndReasonExplicit = true
    }

    const hasExplicitSessionEndReason = () => sessionEndReasonExplicit

    const markCrash = (error: unknown) => {
        logger.debug(`${logPrefix} Unhandled error:`, error)
        exitCode = 1
        archiveReason = 'Session crashed'
        sessionEndReason = 'error'
    }

    const registerProcessHandlers = () => {
        // tiann/hapi#914: SIGTERM is treated as the default reason ('Hub restart')
        // because the runner is restarted by systemd as part of hub restart in
        // production. If a future code path needs to distinguish "operator
        // killed the host process" from "hub restart", it can call
        // setArchiveReason() before the runner exits.
        process.on('SIGTERM', () => {
            void cleanupAndExit()
        })

        // Ctrl-C in a local terminal is genuine user intent — keep the
        // pre-#914 label so the audit trail still shows it.
        process.on('SIGINT', () => {
            archiveReason = 'User terminated'
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
        hasExplicitSessionEndReason,
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
