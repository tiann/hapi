type LiveWorkSession = {
    thinking?: boolean | null
    derivedToolWork?: boolean | null
    backgroundTaskCount?: number | null
    pendingRequestsCount?: number | null
    agentState?: { requests?: Record<string, unknown> | null } | null
}

/**
 * Durable / progress work that survives heartbeat expiry (excludes stale requests).
 * Mirrors `hasDurableLiveWork` in `hub/src/sync/sessionIdle.ts`.
 */
export function sessionHasDurableLiveWork(session: LiveWorkSession): boolean {
    if (session.thinking) return true
    if (session.derivedToolWork === true) return true
    if ((session.backgroundTaskCount ?? 0) > 0) return true
    return false
}

/**
 * Hub-visible work that must block archive (tiann/hapi#2020).
 * Mirrors `hasLiveWork` in `hub/src/sync/sessionIdle.ts` — keep them aligned.
 */
export function sessionHasLiveWork(session: LiveWorkSession): boolean {
    if (sessionHasDurableLiveWork(session)) return true
    if ((session.pendingRequestsCount ?? 0) > 0) return true
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) return true
    return false
}
