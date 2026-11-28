type LiveWorkSession = {
    thinking?: boolean | null
    derivedToolWork?: boolean | null
    backgroundTaskCount?: number | null
    pendingRequestsCount?: number | null
    agentState?: { requests?: Record<string, unknown> | null } | null
    // SessionSummary metadata is a wider wire type; read only the archive-gate fields.
    metadata?: {
        idleReconcileExempt?: boolean | null
        waiting?: { since?: number; reason?: string } | null
        unresolvedTurn?: unknown
        backgroundWork?: { tasks?: unknown[] } | null
        [key: string]: unknown
    } | null
}

/**
 * Durable / progress work that survives heartbeat expiry (excludes stale requests).
 * Mirrors `hasDurableLiveWork` in `hub/src/sync/sessionIdle.ts`.
 */
export function sessionHasDurableLiveWork(session: LiveWorkSession): boolean {
    if (session.thinking) return true
    if (session.derivedToolWork === true) return true
    if ((session.backgroundTaskCount ?? 0) > 0) return true
    const background = session.metadata?.backgroundWork
    if (background && Array.isArray(background.tasks) && background.tasks.length > 0) {
        return true
    }
    if (session.metadata?.unresolvedTurn && typeof session.metadata.unresolvedTurn === 'object') {
        return true
    }
    if (session.metadata?.waiting && typeof session.metadata.waiting === 'object') {
        return true
    }
    return false
}

/**
 * Hub-visible work that must never be reconciled away as a zombie.
 * Mirrors `hasLiveWork` in `hub/src/sync/sessionIdle.ts` — keep them aligned.
 * Not a destroy-state liveness gate; use `sessionBlocksHardArchive` for Archive.
 */
export function sessionHasLiveWork(session: LiveWorkSession): boolean {
    if (sessionHasDurableLiveWork(session)) return true
    if ((session.pendingRequestsCount ?? 0) > 0) return true
    const requests = session.agentState?.requests
    if (requests && Object.keys(requests).length > 0) return true
    return false
}

/** Mirrors `blocksHardArchive` — refuse Archive UI / Kill for exempt + waiting. */
export function sessionBlocksHardArchive(session: LiveWorkSession): boolean {
    if (session.metadata?.idleReconcileExempt === true) return true
    return sessionHasLiveWork(session)
}
