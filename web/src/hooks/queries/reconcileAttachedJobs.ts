import type { SessionSummary, SessionsResponse } from '@/types/api'

/**
 * Keep a fresher attachedJob from an in-flight SSE cache when a slower
 * /api/sessions response would otherwise clobber it (clear/progress race).
 */
export function reconcileAttachedJobsFromCache(
    fetched: SessionsResponse,
    cached: SessionsResponse | undefined
): SessionsResponse {
    if (!cached?.sessions?.length) {
        return fetched
    }
    const cachedById = new Map(cached.sessions.map((session) => [session.id, session]))
    return {
        ...fetched,
        sessions: fetched.sessions.map((session) => {
            const previous = cachedById.get(session.id)
            if (!previous) {
                return session
            }
            const previousAt = previous.attachedJobUpdatedAt ?? 0
            const fetchedAt = session.attachedJobUpdatedAt ?? 0
            if (previousAt <= fetchedAt) {
                return session
            }
            return {
                ...session,
                attachedJob: previous.attachedJob,
                attachedJobUpdatedAt: previous.attachedJobUpdatedAt,
            } satisfies SessionSummary
        }),
    }
}
