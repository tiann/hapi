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
 * Durable latch belongs to the session's current worker generation.
 *
 * Current-marker-only (#2021 / #2657): when both markers are present and
 * differ, the latch is prior-generation and does **not** count as live work
 * for Archive. Missing markers fail closed (still count). Residual hole:
 * a still-running prior worker is not detected — see tiann/hapi#2657.
 */
export function latchIsCurrentGeneration(
    latchMarker: unknown,
    currentMarker: unknown,
): boolean {
    if (typeof latchMarker !== 'string' || latchMarker.length === 0) return true
    if (typeof currentMarker !== 'string' || currentMarker.length === 0) return true
    return latchMarker === currentMarker
}

/** Durable / progress work that survives heartbeat expiry (excludes stale requests). */
export function hasDurableLiveWork(session: Session): boolean {
    if (session.thinking) return true
    // Hub-derived open tool work in the transcript tail (autonomous rounds
    // that miss the CLI's turn-scoped thinking flag).
    if (session.derivedToolWork === true) return true
    const currentMarker = session.metadata?.hostStartMarker
    // In-memory count is the current worker's report (zeroed on host replace).
    if ((session.backgroundTaskCount ?? 0) > 0) return true
    // Durable background snapshot for the *current* worker only (#2021
    // current-marker-only / #2657). Prior-gen records may remain in metadata
    // for debugging but must not strand Archive forever.
    const background = session.metadata?.backgroundWork
    if (
        background
        && Array.isArray(background.tasks)
        && background.tasks.length > 0
        && latchIsCurrentGeneration(background.hostStartMarker, currentMarker)
    ) {
        return true
    }
    // In-flight turn latch for the current worker. Survives expiry clearing
    // ephemeral thinking. Foreign-generation latches are ignored here (#2657).
    const unresolved = session.metadata?.unresolvedTurn
    if (
        unresolved
        && typeof unresolved === 'object'
        && latchIsCurrentGeneration(unresolved.hostStartMarker, currentMarker)
    ) {
        return true
    }
    // Externally blocked work (CI / vendor / peer) — not turn-scoped thinking
    // (#2020 dogfood). Survives between poll ticks so Archive cannot Kill.
    const waiting = session.metadata?.waiting
    if (waiting && typeof waiting === 'object') {
        return true
    }
    return false
}

/**
 * Work the hub can see that must never be reconciled away as a zombie.
 *
 * Scope is hub *visibility*, not process liveness. Callers that destroy state
 * (hard Archive / KillSession) must not treat a false result as "safe to
 * reap" — a session can be alive while waiting on CI, a vendor, or a peer
 * with none of these signals set. Use `blocksHardArchive` for destroy paths
 * (tiann/hapi#2020).
 */
export function hasLiveWork(session: Session): boolean {
    if (hasDurableLiveWork(session)) return true
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
 * Refuse hard Archive / KillSession before stop RPCs (#2020).
 *
 * Broader than `hasLiveWork`: honours `idleReconcileExempt` (already used by
 * reversible keepalive-idle reconcile) and durable `waiting` for externally
 * blocked work that hub-visible turn signals miss.
 */
export function blocksHardArchive(session: Session): boolean {
    if (session.metadata?.idleReconcileExempt === true) return true
    return hasLiveWork(session)
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
