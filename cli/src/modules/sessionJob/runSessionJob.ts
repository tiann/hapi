/**
 * Supervise a child command while heartbeating a session-attached job.
 * Fixes the idle-agent heartbeat gap (cold review #1404).
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import type { AttachedJobUpsert } from '@hapi/protocol'
import { killProcessByChildProcess } from '@/utils/process'
import {
    SessionJobError,
    resolveSessionJobClient,
    setSessionJob,
    updateSessionJob,
    type SessionJobClientOptions,
    type SessionJobResolvedClient
} from './sessionJob'
import { stampUntilProgress } from './jobProgressMode'

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
    /** When set, heartbeats re-stamp remaining from wall clock (progress until). */
    untilMs?: number
    /**
     * Window start for until-mode total (until − startedAt). Defaults to supervisor
     * launch time. Pass the original window start on mid-window re-attach so the
     * bar does not reset to "time left from this restart."
     */
    startedAtMs?: number
    wakeOnTerminal?: boolean
    wakePrompt?: string
    /** Injected for tests. */
    spawnImpl?: typeof spawn
    setIntervalImpl?: typeof setInterval
    clearIntervalImpl?: typeof clearInterval
    /** Injected for tests (terminal-status retry backoff). */
    sleepImpl?: (ms: number) => Promise<void>
    /** Injected for tests — wall clock for hub-down terminal retry deadline. */
    nowImpl?: () => number
    /**
     * How long to keep retrying terminal PATCH while the hub is unreachable
     * (ECONNREFUSED after `hapi-restart-hub`, brief remat, etc.). Default 10m.
     */
    terminalHubDownDeadlineMs?: number
    /** Injected for tests — defaults to tree-kill via killProcessByChildProcess. */
    killChildImpl?: (child: ChildProcess, signal: NodeJS.Signals) => void | Promise<boolean>
}

const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000
const TERMINAL_STATUS_ATTEMPTS = 3
const DEFAULT_TERMINAL_HUB_DOWN_DEADLINE_MS = 10 * 60 * 1000
const TERMINAL_HUB_DOWN_BACKOFF_CAP_MS = 30_000

/** Argv tokens that take this hub (or active stack) down mid-supervision. */
const HUB_STACK_CONTROL_BASENAMES = new Set([
    'hapi-restart-hub',
    'hapi-use-worktree',
    'hapi-use-driver',
    'hapi-watch-activate-driver',
])

/**
 * True when the supervised argv would restart/swap this hub while `job run`
 * still needs a terminal PATCH — wrapping these creates zombie `running` meters
 * unless the hub is reachable again within the hub-down retry window.
 */
export function commandLooksLikeHubStackControl(command: string[]): boolean {
    for (const arg of command) {
        for (const token of arg.split(/[\s]+/).filter(Boolean)) {
            const base = basename(token)
            if (HUB_STACK_CONTROL_BASENAMES.has(base)) return true
        }
    }
    return false
}

/** Connection / gateway failures where retrying after hub restart can succeed. */
export function isHubUnreachableError(error: unknown): boolean {
    if (error instanceof SessionJobError) {
        if (error.code === 'run_mismatch' || error.code === 'not_found') return false
        // Prefer numeric status: httpStatusError may replace "HTTP 503" with hub JSON text
        // like "Not connected", which must still use the hub-down retry window.
        if (error.httpStatus !== undefined && error.httpStatus >= 502 && error.httpStatus <= 504) {
            return true
        }
        if (/HTTP 502|HTTP 503|HTTP 504|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|hub unreachable|Network Error/i.test(error.message)) {
            return true
        }
    }
    if (error && typeof error === 'object') {
        const e = error as { code?: string; message?: string; cause?: unknown }
        if (typeof e.code === 'string'
            && /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH)$/.test(e.code)) {
            return true
        }
        if (typeof e.message === 'string'
            && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|Network Error|hub unreachable/i.test(e.message)) {
            return true
        }
        if (e.cause !== undefined) return isHubUnreachableError(e.cause)
    }
    if (error instanceof Error) {
        return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|Network Error|hub unreachable/i.test(error.message)
    }
    return false
}

function terminalBackoffMs(attempt: number, hubDown: boolean): number {
    if (!hubDown) return 1_000 * 2 ** attempt
    return Math.min(2_000 * 2 ** attempt, TERMINAL_HUB_DOWN_BACKOFF_CAP_MS)
}

async function markTerminalWithRetry(options: {
    clientOpts: SessionJobClientOptions & { resolved: SessionJobResolvedClient }
    jobKey: string
    status: 'completed' | 'failed'
    detail?: string
    expectedRunId: string
    sleep: (ms: number) => Promise<void>
    now: () => number
    hubDownDeadlineMs: number
}): Promise<void> {
    let lastError: unknown
    let attempt = 0
    const startedAt = options.now()
    let loggedHubDownWait = false
    for (;;) {
        try {
            await updateSessionJob({
                ...options.clientOpts,
                jobKey: options.jobKey,
                body: {
                    status: options.status,
                    expectedRunId: options.expectedRunId,
                    ...(options.detail !== undefined ? { detail: options.detail } : {}),
                },
            })
            return
        } catch (error) {
            lastError = error
            // Another run owns the key — retrying cannot help and may confuse logs.
            if (error instanceof SessionJobError && error.code === 'run_mismatch') {
                break
            }

            const hubDown = isHubUnreachableError(error)
            const elapsed = options.now() - startedAt
            const withinHubDownBudget = hubDown && elapsed < options.hubDownDeadlineMs
            const withinShortBudget = !hubDown && attempt < TERMINAL_STATUS_ATTEMPTS - 1

            // Operator cleared the meter while the child still ran — detached, not a
            // supervision failure. Retry transient 404s; accept absence when budget ends.
            if (error instanceof SessionJobError && error.code === 'not_found') {
                if (!withinShortBudget && !withinHubDownBudget) {
                    return
                }
            } else if (!withinShortBudget && !withinHubDownBudget) {
                break
            }

            if (hubDown && !loggedHubDownWait) {
                loggedHubDownWait = true
                const message = error instanceof Error ? error.message : String(error)
                console.error(
                    `[hapi job run] hub unreachable after child exit (${message}); `
                    + `retrying terminal ${options.status} for up to `
                    + `${Math.round(options.hubDownDeadlineMs / 1000)}s`
                )
            }

            await options.sleep(terminalBackoffMs(attempt, hubDown))
            attempt += 1
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function runSessionJob(options: RunSessionJobOptions): Promise<number> {
    if (options.command.length === 0) {
        throw new SessionJobError('bad_args', 'run requires a command after --')
    }

    if (commandLooksLikeHubStackControl(options.command)) {
        throw new SessionJobError(
            'bad_args',
            'do not wrap hapi-restart-hub / hapi-use-worktree / hapi-use-driver / '
            + 'hapi-watch-activate-driver in `hapi job run` — the hub is down exactly when '
            + 'the terminal status PATCH must land, leaving a zombie running meter. '
            + 'Run the hub restart outside the job (job = remat/work only; restart after exit).'
        )
    }

    // Hub stamps startedAt when runId starts a new generation (runner/hub
    // clocks may skew) unless the caller passes an explicit window start.
    // runId is the unique generation fence.
    const runId = randomUUID()
    const body: AttachedJobUpsert = {
        label: options.label,
        status: 'running',
        runId,
        ...(options.done !== undefined ? { done: options.done } : {}),
        ...(options.total !== undefined ? { total: options.total } : {}),
        ...(options.remaining !== undefined ? { remaining: options.remaining } : {}),
        ...(options.unit !== undefined ? { unit: options.unit } : {}),
        ...(options.detail !== undefined ? { detail: options.detail } : {}),
        ...(options.startedAtMs !== undefined ? { startedAt: options.startedAtMs } : {}),
        ...(options.wakeOnTerminal !== undefined ? { wakeOnTerminal: options.wakeOnTerminal } : {}),
        ...(options.wakePrompt !== undefined ? { wakePrompt: options.wakePrompt } : {})
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
    const sleep = options.sleepImpl
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const now = options.nowImpl ?? Date.now
    const hubDownDeadlineMs = options.terminalHubDownDeadlineMs ?? DEFAULT_TERMINAL_HUB_DOWN_DEADLINE_MS
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

    const child: ChildProcess = spawnFn(options.command[0]!, options.command.slice(1), {
        stdio: 'inherit',
        env: process.env
    })

    let loggedHeartbeatFailure = false
    let inflightHeartbeat: Promise<unknown> = Promise.resolve()
    // Until-mode total = until − windowStart. Prefer explicit startedAtMs so a
    // mid-window move keeps the original 48h (etc.) denominator.
    const untilWindowStartMs = options.startedAtMs ?? now()
    const heartbeat = setIntervalFn(() => {
        // Never PATCH status:running on the heartbeat — a late in-flight
        // request must not resurrect running after the terminal write.
        // Fence with runId so a superseded run cannot touch a key reuse.
        // Do not re-send --detail: MCP/CLI progress updates would otherwise be
        // clobbered by the next timer tick with the launch-time string.
        const untilBody = options.untilMs !== undefined
            ? (() => {
                const stamped = stampUntilProgress(options.untilMs!, now(), untilWindowStartMs)
                return {
                    remaining: stamped.remaining,
                    total: stamped.total,
                    unit: options.unit ?? stamped.unit
                }
            })()
            : {}
        inflightHeartbeat = updateSessionJob({
            ...clientOpts,
            jobKey: options.jobKey,
            body: { expectedRunId: runId, ...untilBody }
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

    // Forward the received signal through tree-kill (not always SIGTERM) and
    // await verified teardown before writing terminal job state.
    let terminationPromise: Promise<boolean> | null = null
    const forward = (signal: NodeJS.Signals) => {
        if (child.pid && !child.killed) {
            // Tree-kill: a supervised shell can exit while a grandchild keeps
            // running; bare process.kill(child.pid) would leave orphans and let
            // the wrapper mark the job terminal while work continues.
            const killChild = options.killChildImpl
                ?? ((target: ChildProcess, sig: NodeJS.Signals) =>
                    killProcessByChildProcess(target, false, sig))
            terminationPromise ??= Promise.resolve(killChild(child, signal)).then(
                (result) => result !== false
            )
        }
    }
    const onSigInt = () => forward('SIGINT')
    const onSigTerm = () => forward('SIGTERM')
    process.on('SIGINT', onSigInt)
    process.on('SIGTERM', onSigTerm)

    let spawnErrorDetail: string | undefined
    const exitCode = await new Promise<number>((resolve) => {
        child.on('error', async (error) => {
            clearIntervalFn(heartbeat)
            spawnErrorDetail = error.message
            resolve(127)
        })
        child.on('exit', (code, signal) => {
            clearIntervalFn(heartbeat)
            if (signal) {
                const signalNumber = osConstants.signals[signal] ?? 1
                resolve(128 + signalNumber)
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

    let treeKillFailed = false
    if (terminationPromise) {
        const stopped = await terminationPromise
        if (!stopped) {
            treeKillFailed = true
            console.error('[hapi job run] failed to terminate the complete child process tree')
        }
    }

    const terminalStatus = exitCode === 0 && !treeKillFailed ? 'completed' : 'failed'
    let terminalWriteFailed = false
    try {
        await markTerminalWithRetry({
            clientOpts,
            jobKey: options.jobKey,
            status: terminalStatus,
            expectedRunId: runId,
            ...(spawnErrorDetail !== undefined
                ? { detail: spawnErrorDetail }
                : treeKillFailed
                    ? { detail: 'failed to terminate the complete child process tree' }
                    : {}),
            sleep,
            now,
            hubDownDeadlineMs,
        })
    } catch (error) {
        // run_mismatch means another generation owns the key — not our meter to fix.
        // not_found means the meter was cleared externally (e.g. session_job clear).
        terminalWriteFailed = !(
            error instanceof SessionJobError
            && (error.code === 'run_mismatch' || error.code === 'not_found')
        )
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[hapi job run] failed to mark job ${terminalStatus}: ${message}`)
    }

    // Child success with a frozen "running" meter (or uncleared descendants) is
    // worse than a nonzero exit — surface the supervision failure so wrappers/CI
    // cannot claim green.
    if (treeKillFailed) {
        return exitCode === 0 ? 1 : exitCode
    }
    return exitCode === 0 && terminalWriteFailed ? 1 : exitCode
}
