/**
 * Supervise a child command while heartbeating a session-attached job.
 * Fixes the idle-agent heartbeat gap (cold review #1404).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { AttachedJobUpsert } from '@hapi/protocol'
import {
    SessionJobError,
    resolveSessionJobClient,
    setSessionJob,
    updateSessionJob,
    type SessionJobClientOptions,
    type SessionJobResolvedClient
} from './sessionJob'

export type RunSessionJobOptions = SessionJobClientOptions & {
    jobKey: string
    label: string
    command: string[]
    heartbeatMs?: number
    remaining?: number
    done?: number
    total?: number
    unit?: string
    detail?: string
    /** Injected for tests. */
    spawnImpl?: typeof spawn
    setIntervalImpl?: typeof setInterval
    clearIntervalImpl?: typeof clearInterval
}

const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000

export async function runSessionJob(options: RunSessionJobOptions): Promise<number> {
    if (options.command.length === 0) {
        throw new SessionJobError('bad_args', 'run requires a command after --')
    }

    const body: AttachedJobUpsert = {
        label: options.label,
        status: 'running',
        // Supervised child: always this run's clock. Omitting startedAt would
        // sticky-reuse a prior completed/failed row's startedAt on key reuse.
        startedAt: Date.now(),
        ...(options.done !== undefined ? { done: options.done } : {}),
        ...(options.total !== undefined ? { total: options.total } : {}),
        ...(options.remaining !== undefined ? { remaining: options.remaining } : {}),
        ...(options.unit !== undefined ? { unit: options.unit } : {}),
        ...(options.detail !== undefined ? { detail: options.detail } : {})
    }

    // Cache sessionId for the run. JWT is refreshed in-place before hub's 4h
    // expiry and on 401 (see sessionJob.withAuthedRequest) — do not skip refresh.
    const resolved: SessionJobResolvedClient = await resolveSessionJobClient(options)
    const clientOpts = {
        sessionIdPrefix: options.sessionIdPrefix,
        resolved,
        accessToken: options.accessToken,
        apiUrl: options.apiUrl,
        http: options.http
    }

    await setSessionJob({
        ...clientOpts,
        jobKey: options.jobKey,
        body
    })

    const spawnFn = options.spawnImpl ?? spawn
    const setIntervalFn = options.setIntervalImpl ?? setInterval
    const clearIntervalFn = options.clearIntervalImpl ?? clearInterval
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

    const child: ChildProcess = spawnFn(options.command[0]!, options.command.slice(1), {
        stdio: 'inherit',
        env: process.env
    })

    let loggedHeartbeatFailure = false
    let inflightHeartbeat: Promise<unknown> = Promise.resolve()
    const heartbeat = setIntervalFn(() => {
        // Never PATCH status:running on the heartbeat — a late in-flight
        // request must not resurrect running after the terminal write.
        inflightHeartbeat = updateSessionJob({
            ...clientOpts,
            jobKey: options.jobKey,
            body: options.detail !== undefined ? { detail: options.detail } : {}
        }).catch((error: unknown) => {
            // Best-effort — exit path still marks terminal status. Log once so
            // a broken supervisor is visible (stuck chip with dead PID is worse).
            if (!loggedHeartbeatFailure) {
                loggedHeartbeatFailure = true
                const message = error instanceof Error ? error.message : String(error)
                console.error(`[hapi job run] heartbeat failed (will keep trying): ${message}`)
            }
        })
    }, heartbeatMs)
    // Don't keep the event loop alive solely for heartbeats if child already exited.
    heartbeat.unref?.()

    const forward = (signal: NodeJS.Signals) => {
        if (child.pid && !child.killed) {
            try {
                process.kill(child.pid, signal)
            } catch {
                // Child may have already exited.
            }
        }
    }
    const onSigInt = () => forward('SIGINT')
    const onSigTerm = () => forward('SIGTERM')
    process.on('SIGINT', onSigInt)
    process.on('SIGTERM', onSigTerm)

    const exitCode = await new Promise<number>((resolve) => {
        child.on('error', async (error) => {
            clearIntervalFn(heartbeat)
            await inflightHeartbeat.catch(() => undefined)
            try {
                await updateSessionJob({
                    ...clientOpts,
                    jobKey: options.jobKey,
                    body: { status: 'failed', detail: error.message }
                })
            } catch {
                // ignore
            }
            resolve(127)
        })
        child.on('exit', (code, signal) => {
            clearIntervalFn(heartbeat)
            if (signal) {
                resolve(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1))
                return
            }
            resolve(code ?? 1)
        })
    })

    process.off('SIGINT', onSigInt)
    process.off('SIGTERM', onSigTerm)

    // Drain any in-flight heartbeat so a late status:running cannot clobber
    // the terminal completed/failed write.
    await inflightHeartbeat.catch(() => undefined)

    const terminalStatus = exitCode === 0 ? 'completed' : 'failed'
    try {
        await updateSessionJob({
            ...clientOpts,
            jobKey: options.jobKey,
            body: { status: terminalStatus }
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[hapi job run] failed to mark job ${terminalStatus}: ${message}`)
    }

    return exitCode
}
