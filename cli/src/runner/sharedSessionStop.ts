/**
 * Shared Codex executions host multiple HAPI roots in one wrapper PID.
 * Archiving one root must detach that root without tree-killing the wrapper
 * while sibling roots (or a different primary) still use it.
 */

export type SharedStopDecision =
    | { kind: 'keep_wrapper' }
    | { kind: 'allow_kill' }

/** Minimal runtime shape used when TrackedSession was lost (e.g. runner restart). */
export type RuntimeSiblingSnapshot = {
    pid: number
    sessions: Record<string, { active: boolean }>
}

/**
 * True when another root on the same wrapper PID is still active in the
 * durable Codex runtime registry — even if this session's binding is inactive
 * and the runner has no in-memory TrackedSession.
 */
export function wrapperHasActiveSiblingRoots(
    runtimes: RuntimeSiblingSnapshot[],
    sessionId: string,
    wrapperPid: number
): boolean {
    for (const runtime of runtimes) {
        if (runtime.pid !== wrapperPid) continue
        return Object.entries(runtime.sessions).some(
            ([id, binding]) => id !== sessionId && binding.active
        )
    }
    return false
}

/**
 * True when any runtime that still lists `sessionId` (active or not) has at
 * least one other active root. Used before persisted-PID / argv kills after
 * KillSession marked the archived root inactive.
 */
export function sessionRuntimeHasActiveSiblings(
    runtimes: RuntimeSiblingSnapshot[],
    sessionId: string
): boolean {
    for (const runtime of runtimes) {
        if (!(sessionId in runtime.sessions)) continue
        if (Object.entries(runtime.sessions).some(
            ([id, binding]) => id !== sessionId && binding.active
        )) {
            return true
        }
    }
    return false
}

/**
 * PIDs from in-memory runner tracking that still host other shared roots for
 * this session id. Used when the durable runtime registry is missing/unreadable
 * so argv orphan sweeps do not tree-kill a live shared wrapper.
 */
export function trackedSharedWrapperPidsWithSiblings(
    tracked: Iterable<[number, {
        happySessionId?: string
        sharedSessions?: Record<string, unknown>
    }]>,
    sessionId: string
): Set<number> {
    const protectedPids = new Set<number>()
    for (const [pid, session] of tracked) {
        const shared = session.sharedSessions
        if (!shared) continue
        const otherShared = Object.keys(shared).filter((id) => id !== sessionId)
        if (otherShared.length > 0) {
            protectedPids.add(pid)
            continue
        }
        // Target may already have been detached from sharedSessions while the
        // primary happySessionId is a different live root on this wrapper.
        if (typeof session.happySessionId === 'string'
            && session.happySessionId !== sessionId) {
            protectedPids.add(pid)
        }
    }
    return protectedPids
}

/**
 * Mutates `sharedSessions` to drop `sessionId`. Returns whether the wrapper
 * PID must stay alive for remaining roots.
 */
export function detachSharedRootFromWrapper(
    session: {
        happySessionId?: string
        sharedSessions?: Record<string, unknown>
    },
    sessionId: string
): SharedStopDecision {
    const shared = session.sharedSessions
    if (!shared || !Object.prototype.hasOwnProperty.call(shared, sessionId)) {
        return { kind: 'allow_kill' }
    }

    delete shared[sessionId]
    const remainingShared = Object.keys(shared)
    if (remainingShared.length === 0) {
        delete session.sharedSessions
    }

    const primaryIsOther = typeof session.happySessionId === 'string'
        && session.happySessionId !== sessionId
    if (remainingShared.length > 0 || primaryIsOther) {
        return { kind: 'keep_wrapper' }
    }
    return { kind: 'allow_kill' }
}

/**
 * When stop matched the primary `happySessionId`, keep the wrapper if other
 * shared roots are still registered on this PID.
 */
export function keepWrapperForSharedSiblings(
    session: {
        sharedSessions?: Record<string, unknown>
    },
    sessionId: string
): boolean {
    const siblings = Object.keys(session.sharedSessions ?? {})
        .filter((id) => id !== sessionId)
    if (siblings.length === 0) return false
    delete session.sharedSessions?.[sessionId]
    return true
}
