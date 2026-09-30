import { SESSION_LIFECYCLE_IDLE } from '@hapi/protocol'

type LivenessInput = {
    active: boolean
    thinking?: boolean
    backgroundTaskCount?: number
    pendingRequestsCount?: number
    metadata?: { lifecycleState?: string } | null
}

/**
 * Work the hub can see right now. Mirrors `hasLiveWork` in
 * hub/src/sync/sessionIdle.ts: the hub never marks such a session idle, but
 * it also does not lift an existing mark on `thinking` alone (Cursor ACP
 * churn, tiann/hapi#1553), so `idle` + `thinking` is a state the sidebar has
 * to expect. The pinned buckets (#1821) file it under Working; every other
 * derivation must agree, or a row spins while drawn as idle.
 */
export function hasLiveWork(session: LivenessInput): boolean {
    return session.thinking === true
        || (session.backgroundTaskCount ?? 0) > 0
        || (session.pendingRequestsCount ?? 0) > 0
}

/**
 * Connected, but the hub has seen nothing except keepalives for the idle
 * window (tiann/hapi#1820) and nothing is in flight now. `active` stays true
 * on purpose — the socket is up — so anything that wants to read "the agent
 * is alive" must ask here instead of `session.active`.
 */
export function isKeepaliveIdle(session: LivenessInput): boolean {
    return session.active
        && !hasLiveWork(session)
        && session.metadata?.lifecycleState === SESSION_LIFECYCLE_IDLE
}

/** Connected and not idle-marked: the only sessions that should read as live. */
export function isLiveSession(session: LivenessInput): boolean {
    return session.active && !isKeepaliveIdle(session)
}

/** Sort key: live first, then keepalive-idle, then disconnected. */
export function sessionLivenessRank(session: LivenessInput): number {
    if (isLiveSession(session)) return 0
    return session.active ? 1 : 2
}
