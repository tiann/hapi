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
import type { Session } from '@hapi/protocol/types'

/** Keepalive-only for this long ⇒ reconcile `running` → `idle`. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000

/**
 * `HAPI_SESSION_IDLE_TIMEOUT_MS` window, in ms. `0` disables reconciliation
 * entirely; an unset or unparseable value falls back to the default.
 */
export function resolveSessionIdleTimeoutMs(
    env: Record<string, string | undefined> = process.env
): number {
    const raw = env.HAPI_SESSION_IDLE_TIMEOUT_MS
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_SESSION_IDLE_TIMEOUT_MS
    }
    const parsed = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_SESSION_IDLE_TIMEOUT_MS
    }
    return parsed
}

/**
 * Work the hub can see that must never be reconciled away as a zombie.
 *
 * Reports hub *visibility*, not process liveness. A false result means none of
 * these signals are set — not that the session is safe to reap. A session can
 * be alive while waiting on CI, a vendor, or a peer reply with none of the
 * original three turn signals; callers that destroy state must not promote a
 * false result into a liveness verdict (tiann/hapi#2020). Prefer consulting
 * `metadata.waiting` / `idleReconcileExempt` as well when the action is
 * irreversible.
 */
export function hasLiveWork(session: Session): boolean {
    if (session.thinking) return true
    if ((session.backgroundTaskCount ?? 0) > 0) return true
    // A permission / input request waiting on the operator is real state the
    // agent is blocked on, not an abandoned socket.
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) return true
    // Externally blocked work distinct from turn-scoped thinking (#2020).
    const waiting = session.metadata?.waiting
    if (waiting && typeof waiting === 'object') return true
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
    // Opting out after the fact still lifts an existing mark.
    if (session.metadata.idleReconcileExempt === true) return true
    return timeoutMs > 0 && now - agentProgressAt <= timeoutMs
}
