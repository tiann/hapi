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
        ...(options.done !== undefined ? { done: options.done } : {}),
        ...(options.total !== undefined ? { total: options.total } : {}),
        ...(options.remaining !== undefined ? { remaining: options.remaining } : {}),
        ...(options.unit !== undefined ? { unit: options.unit } : {}),
        ...(options.detail !== undefined ? { detail: options.detail } : {})
    }

    // Resolve once — heartbeats must not re-list sessions / re-exchange JWT.
    const resolved: SessionJobResolvedClient = await resolveSessionJobClient(options)
    const clientOpts = {
        sessionIdPrefix: options.sessionIdPrefix,
        resolved,
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

    const heartbeat = setIntervalFn(() => {
        void updateSessionJob({
            ...clientOpts,
            jobKey: options.jobKey,
            body: {
                detail: options.detail,
                status: 'running'
            }
        }).catch(() => {
            // Best-effort — exit path still marks terminal status.
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

    const terminalStatus = exitCode === 0 ? 'completed' : 'failed'
    try {
        await updateSessionJob({
            ...clientOpts,
            jobKey: options.jobKey,
            body: { status: terminalStatus }
        })
    } catch {
        // Job may already be cleared; still return child exit code.
    }

    return exitCode
}
