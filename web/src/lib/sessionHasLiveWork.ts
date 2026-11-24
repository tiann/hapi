/**
 * Hub-visible work that must block archive (tiann/hapi#2020).
 * Mirrors `hasLiveWork` in `hub/src/sync/sessionIdle.ts` — keep them aligned.
 */
export function sessionHasLiveWork(session: {
    thinking?: boolean | null
    backgroundTaskCount?: number | null
    pendingRequestsCount?: number | null
    agentState?: { requests?: Record<string, unknown> | null } | null
}): boolean {
    if (session.thinking) return true
    if ((session.backgroundTaskCount ?? 0) > 0) return true
    if ((session.pendingRequestsCount ?? 0) > 0) return true
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) return true
    return false
}
