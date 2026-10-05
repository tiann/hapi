/**
 * Keepalive-idle reconciliation (tiann/hapi#1820).
 *
 * `sessionCache.expireInactive` only expires a session when its `activeAt`
 * goes stale, and `session-alive` refreshes `activeAt` every couple of
 * seconds for as long as the CLI socket lives. A session whose agent has done
 * nothing for days therefore stays `active: true` / `lifecycleState: running`
 * forever: socket pinging is being read as agent health.
 *
 * This module supplies the missing second signal. `active` keeps its existing
 * meaning (the CLI is reachable — flipping it would arm resume-respawn, dedup
 * merge and delete paths against a session whose process is very much alive);
 * `lifecycleState` moves `running` → `idle` once we have seen nothing but
 * keepalives for the configured window.
 */

import { SESSION_LIFECYCLE_IDLE, SESSION_LIFECYCLE_RUNNING } from '@hapi/protocol'
import type { Metadata, Session } from '@hapi/protocol/types'

/** Keepalive-only for this long ⇒ reconcile `running` → `idle`. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000

/**
 * `HAPI_SESSION_IDLE_TIMEOUT_MS` window, in ms. `0` never marks a session
 * idle (and lifts marks an earlier configuration left behind); an unset or
 * unparseable value falls back to the default.
 *
 * Whole milliseconds only. `parseInt` would read "1h" as 1 ms and quietly
 * mark every session idle on the next tick, so a value with a suffix (or
 * anything else that is not a plain digit string) is refused, and loudly.
 */
export function resolveSessionIdleTimeoutMs(
    env: Record<string, string | undefined> = process.env,
    warn: (message: string) => void = (message) => console.warn(message)
): number {
    const raw = env.HAPI_SESSION_IDLE_TIMEOUT_MS
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_SESSION_IDLE_TIMEOUT_MS
    }
    const trimmed = raw.trim()
    const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
    if (!Number.isSafeInteger(parsed)) {
        warn(`[session-idle] Ignoring HAPI_SESSION_IDLE_TIMEOUT_MS=${JSON.stringify(raw)}: expected whole milliseconds (e.g. 3600000 for 1h); using the default ${DEFAULT_SESSION_IDLE_TIMEOUT_MS}`)
        return DEFAULT_SESSION_IDLE_TIMEOUT_MS
    }
    return parsed
}

/**
 * When the CLI last stamped this session `running`, or `null`.
 *
 * The CLI writes `lifecycleState: 'running'` with a fresh `lifecycleStateSince`
 * exactly once, at bootstrap (cli/src/agent/sessionFactory.ts). For a session
 * reopened after days of silence that stamp is the only sign of life until the
 * first turn, so it counts as agent progress at its own time; otherwise the
 * reopened session reads as idle on the very next tick.
 */
export function lifecycleRunningSince(metadata: Metadata | null | undefined): number | null {
    if (metadata?.lifecycleState !== SESSION_LIFECYCLE_RUNNING) return null
    const since = metadata.lifecycleStateSince
    return typeof since === 'number' ? since : null
}

/** Work the hub can see that must never be reconciled away as a zombie. */
function hasLiveWork(session: Session): boolean {
    if (session.thinking) return true
    if ((session.backgroundTaskCount ?? 0) > 0) return true
    // A permission / input request waiting on the operator is real state the
    // agent is blocked on, not an abandoned socket.
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) return true
    return false
}

/**
 * Should this session be reconciled `running` → `idle` right now?
 *
 * `agentProgressAt` is the last time the hub observed actual agent progress
 * (a message in either direction, a queued prompt, a background task), NOT
 * the last keepalive.
 */
export function shouldMarkKeepaliveIdle(
    session: Session,
    agentProgressAt: number,
    now: number,
    timeoutMs: number
): boolean {
    if (timeoutMs <= 0) return false
    // Only sessions the hub still believes are live. An inactive row is #842's
    // problem, not this one.
    if (!session.active) return false
    if (session.metadata?.lifecycleState !== SESSION_LIFECYCLE_RUNNING) return false
    if (session.metadata.idleReconcileExempt === true) return false
    if (hasLiveWork(session)) return false
    return now - agentProgressAt > timeoutMs
}

/**
 * Should an already-`idle` session be reconciled back to `running`?
 *
 * Only real progress wakes a session, never `thinking`. Cursor ACP emits
 * ambient idle/running churn on sessions that are doing nothing
 * (tiann/hapi#1553); waking on it would flap the lifecycle — and a DB write
 * plus a full-session broadcast — on every 5 s tick. A session that is
 * genuinely working emits messages, and those do wake it.
 */
export function shouldClearKeepaliveIdle(
    session: Session,
    agentProgressAt: number,
    now: number,
    timeoutMs: number
): boolean {
    if (session.metadata?.lifecycleState !== SESSION_LIFECYCLE_IDLE) return false
    // Opting out after the fact still lifts an existing mark, and so does
    // disabling the window: the CLI only stamps `running` at bootstrap, so a
    // mark left behind by an earlier configuration would otherwise outlive
    // the configuration that made it.
    if (session.metadata.idleReconcileExempt === true || timeoutMs <= 0) return true
    return now - agentProgressAt <= timeoutMs
}
