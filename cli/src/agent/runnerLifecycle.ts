import type { ApiSessionClient } from '@/api/apiSession'
import { logger } from '@/ui/logger'
import { restoreTerminalState } from '@/ui/terminalState'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { readProcessIdentity } from '@/runner/processIdentity'
import type { ManagedStopReason, ManagedStoppedBy } from '@hapi/protocol'
import { readManagedOutcomeSigningContext, signManagedOutcome, spoolManagedOutcome } from '@/runner/managedOutcomeMailbox'
import type { ManagedOutcome } from '@/runner/ownershipJournal'
import { submitManagedOutcome } from '@/runner/controlClient'

export type VerifiedManagedStopIntent = {
    stoppedBy: ManagedStoppedBy
    stopReasonCode: ManagedStopReason
}

type RunnerLifecycleOptions = {
    session: ApiSessionClient
    logTag: string
    stopKeepAlive?: () => void
    onBeforeClose?: () => Promise<void> | void
    onAfterClose?: () => Promise<void> | void
    resolveManagedStopIntent?: () => Promise<VerifiedManagedStopIntent | null>
    onManagedOutcomeAcknowledged?: (receipt: {
        launchNonce: string
        idempotencyKey: string
        outcome: ManagedOutcome
    }) => Promise<void> | void
}

export type RunnerLifecycle = {
    setExitCode: (code: number) => void
    setArchiveReason: (reason: string) => void
    markCrash: (error: unknown) => void
    cleanup: () => Promise<void>
    cleanupAndExit: (codeOverride?: number) => Promise<void>
    registerProcessHandlers: () => void
    markManagedUnhealthy: (reason: ManagedStopReason) => void
}

export function createRunnerLifecycle(options: RunnerLifecycleOptions): RunnerLifecycle {
    let exitCode = 0
    let archiveReason = 'User terminated'
    let cleanupStarted = false
    let cleanupPromise: Promise<void> | null = null
    let managedStopIntent: VerifiedManagedStopIntent | null = null
    let managedStopIntentRead: Promise<void> | null = null
    let managedUnhealthyReason: ManagedStopReason | null = null
    const signingContext = readManagedOutcomeSigningContext()

    const logPrefix = `[${options.logTag}]`

    const publishManagedOutcome = async (outcome: ManagedOutcome) => {
        if (!signingContext) return
        const idempotencyKey = randomUUID()
        const envelope = signManagedOutcome(signingContext.privateKey, {
            launchNonce: signingContext.launchNonce,
            idempotencyKey,
            outcome
        })
        const home = process.env.HAPI_HOME || join(os.homedir(), '.hapi')
        for (;;) {
            let acknowledged = false
            try {
                const result = await submitManagedOutcome(envelope)
                acknowledged = result.acknowledged
            } catch (error) {
                logger.debug(`${logPrefix} Managed outcome submission failed; spooling locally`, error)
            }
            if (acknowledged) {
                await options.onManagedOutcomeAcknowledged?.({
                    launchNonce: signingContext.launchNonce,
                    idempotencyKey,
                    outcome: structuredClone(outcome)
                })
                return
            }
            try {
                await spoolManagedOutcome(home, envelope)
                return
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
                logger.debug(`${logPrefix} Managed outcome spool failed; retrying`, error)
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
    }

    const throwCleanupErrors = (errors: unknown[]) => {
        if (errors.length === 0) return
        if (errors.length === 1) throw errors[0]
        throw new AggregateError(errors, 'Multiple runner lifecycle cleanup steps failed')
    }

    const ensureManagedStopIntentRead = (): Promise<void> | null => {
        if (managedStopIntentRead) return managedStopIntentRead
        if (!signingContext && !options.resolveManagedStopIntent) return null
        managedStopIntentRead = (async () => {
            try {
                managedStopIntent = await (options.resolveManagedStopIntent?.() ?? readManagedStopIntent())
            } catch (error) {
                logger.debug(`${logPrefix} Failed to resolve managed stop intent:`, error)
                managedStopIntent = null
            }
        })()
        return managedStopIntentRead
    }

    const finalizeSession = async (
        outcome: ManagedOutcome,
        updateMetadata: Parameters<ApiSessionClient['updateMetadata']>[0]
    ) => {
        const errors: unknown[] = []
        const attempt = async (step: () => Promise<void> | void) => {
            try {
                await step()
            } catch (error) {
                errors.push(error)
            }
        }
        await attempt(() => publishManagedOutcome(outcome))
        await attempt(() => options.session.updateMetadata(updateMetadata))
        await attempt(() => options.session.sendSessionDeath())
        await attempt(() => options.session.flush())
        await attempt(() => options.session.close())
        throwCleanupErrors(errors)
    }

    const archiveAndClose = async () => {
        if (managedUnhealthyReason) {
            const reason = managedUnhealthyReason
            await finalizeSession({ lifecycleState: 'unhealthy', stopReasonCode: reason }, (currentMetadata) => ({
                ...currentMetadata,
                lifecycleState: 'unhealthy',
                lifecycleStateSince: Date.now(),
                stopReasonCode: reason
            }))
            return
        }
        if (managedStopIntent) {
            const stopIntent = managedStopIntent
            await finalizeSession({
                lifecycleState: 'stopped',
                stoppedBy: stopIntent.stoppedBy,
                stopReasonCode: stopIntent.stopReasonCode
            }, (currentMetadata) => ({
                ...currentMetadata,
                lifecycleState: 'stopped',
                lifecycleStateSince: Date.now(),
                stoppedBy: stopIntent.stoppedBy,
                stopReasonCode: stopIntent.stopReasonCode
            }))
            return
        }
        await finalizeSession({ lifecycleState: 'archived' }, (currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason
        }))
    }

    const cleanup = async () => {
        if (cleanupPromise) {
            return cleanupPromise
        }

        cleanupStarted = true
        cleanupPromise = (async () => {
            logger.debug(`${logPrefix} Cleanup start`)
            restoreTerminalState()
            const stopIntentRead = ensureManagedStopIntentRead()

            const errors: unknown[] = []
            try {
                options.stopKeepAlive?.()
                await options.onBeforeClose?.()
            } catch (error) {
                logger.debug(`${logPrefix} Error during pre-cleanup:`, error)
                errors.push(error)
            }
            if (stopIntentRead) {
                await stopIntentRead
            }
            try {
                await archiveAndClose()
            } catch (error) {
                errors.push(error)
            } finally {
                try {
                    await options.onAfterClose?.()
                } catch (error) {
                    logger.debug(`${logPrefix} Error during post-cleanup:`, error)
                    errors.push(error)
                }
            }
            throwCleanupErrors(errors)
            logger.debug(`${logPrefix} Cleanup complete`)
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

    const markCrash = (error: unknown) => {
        logger.debug(`${logPrefix} Unhandled error:`, error)
        exitCode = 1
        archiveReason = 'Session crashed'
    }

    const registerProcessHandlers = () => {
        process.on('SIGTERM', () => {
            ensureManagedStopIntentRead()
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
        markCrash,
        cleanup,
        cleanupAndExit,
        registerProcessHandlers,
        markManagedUnhealthy: (reason) => { managedUnhealthyReason = reason }
    }
}

function exactArg(argv: string[], flag: string): string | null {
    const index = argv.indexOf(flag)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

export async function readManagedStopIntent(options: {
    home?: string
    argv?: string[]
    pid?: number
} = {}): Promise<VerifiedManagedStopIntent | null> {
    const argv = options.argv ?? process.argv
    const launchNonce = exactArg(argv, '--hapi-launch-nonce')
    const runnerInstanceId = exactArg(argv, '--hapi-runner-instance')
    const home = options.home ?? process.env.HAPI_HOME ?? join(os.homedir(), '.hapi')
    const pid = options.pid ?? process.pid
    if (!launchNonce || !runnerInstanceId || !home) return null

    try {
        const canonicalHome = resolve(home)
        const state = JSON.parse(await readFile(join(canonicalHome, 'runner-sessions.v1.json'), 'utf8')) as {
            launches?: Record<string, {
                runnerInstanceId?: string
                pid?: number
                birthToken?: string
                recycleIntent?: { pid?: number; birthToken?: string; reason?: ManagedStopReason }
            }>
        }
        const launch = state.launches?.[launchNonce]
        const identity = await readProcessIdentity(pid)
        const intent = launch?.recycleIntent
        if (!launch || !identity || launch.runnerInstanceId !== runnerInstanceId || launch.pid !== pid || launch.birthToken !== identity.birthToken) return null
        if (!intent || intent.pid !== pid || intent.birthToken !== identity.birthToken) return null
        if (!['runner-recycle', 'stale-owner-term'].includes(intent.reason ?? '')) return null
        return {
            stoppedBy: 'runner-recycle',
            stopReasonCode: intent.reason as ManagedStopReason
        }
    } catch {
        return null
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
