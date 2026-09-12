import { getSessionListSortTimestamp, toSessionSummary } from '@hapi/protocol'
import type {
    Session,
    SessionResponse,
    SessionSummary,
    SessionsResponse
} from '@/types/api'

/**
 * Full session records carry the session sequence that also versions the
 * reply clock. REST responses race the two SSE connections, so an older
 * response must not replace a newer cached record.
 */
export function shouldAcceptSessionRecord(current: Session | undefined, incoming: Session): boolean {
    return current === undefined || incoming.seq >= (Number.isFinite(current.seq) ? current.seq : 0)
}

/** A rejected REST detail snapshot needs one bounded recovery fetch. */
export function needsSessionResponseRetry(
    current: SessionResponse | undefined,
    incoming: SessionResponse
): boolean {
    return Boolean(current?.session && !shouldAcceptSessionRecord(current.session, incoming.session))
}

/**
 * List summaries retain the full-record sequence as the reply-clock
 * watermark. This is the SSE full-record gate; REST list hydration uses the
 * equivalent `lastAssistantMessageVersion` comparison per row below.
 */
export function shouldAcceptSessionSummaryRecord(
    current: SessionSummary | undefined,
    incoming: Pick<Session, 'seq'>
): boolean {
    return current === undefined || incoming.seq >= (current.lastAssistantMessageVersion ?? 0)
}

export function shouldAcceptRefreshedSessionSummary(
    current: SessionSummary | undefined,
    incoming: SessionSummary
): boolean {
    return current === undefined
        || (incoming.lastAssistantMessageVersion ?? 0) >= (current.lastAssistantMessageVersion ?? 0)
}

/** A rejected REST list snapshot needs one bounded recovery fetch. */
export function needsSessionsResponseRetry(
    current: SessionsResponse | undefined,
    incoming: SessionsResponse,
    getCachedDetail?: (sessionId: string) => Session | undefined
): boolean {
    const currentById = new Map((current?.sessions ?? []).map((session) => [session.id, session]))
    return incoming.sessions.some((session) => {
        const cached = currentById.get(session.id)
        const detail = getCachedDetail?.(session.id)
        const watermark = Math.max(
            cached?.lastAssistantMessageVersion ?? 0,
            detail?.seq ?? 0
        )
        return (session.lastAssistantMessageVersion ?? 0) < watermark
    })
}

export function sortSessionSummaries(left: SessionSummary, right: SessionSummary): number {
    if (Boolean(left.globalPinned) !== Boolean(right.globalPinned)) {
        return left.globalPinned ? -1 : 1
    }
    if (Boolean(left.pinned) !== Boolean(right.pinned)) {
        return left.pinned ? -1 : 1
    }
    if (left.active !== right.active) {
        return left.active ? -1 : 1
    }
    if (left.active && left.pendingRequestsCount !== right.pendingRequestsCount) {
        return right.pendingRequestsCount - left.pendingRequestsCount
    }
    return getSessionListSortTimestamp(right) - getSessionListSortTimestamp(left)
}

/** Keep a newer SSE detail record when a slower REST request returns stale data. */
export function mergeSessionResponse(
    current: SessionResponse | undefined,
    incoming: SessionResponse
): SessionResponse {
    return current?.session && !shouldAcceptSessionRecord(current.session, incoming.session)
        ? current
        : incoming
}

/**
 * Merge a REST list response against the current cache by session id. REST
 * remains authoritative for membership, while a newer SSE row/detail wins for
 * each session whose reply-clock watermark is ahead of the response.
 */
export function mergeSessionsResponse(
    current: SessionsResponse | undefined,
    incoming: SessionsResponse,
    getCachedDetail?: (sessionId: string) => Session | undefined
): SessionsResponse {
    const currentById = new Map((current?.sessions ?? []).map((session) => [session.id, session]))
    const sessions = incoming.sessions.map((session) => {
        const cached = currentById.get(session.id)
        const detail = getCachedDetail?.(session.id)
        const cachedVersion = cached?.lastAssistantMessageVersion ?? 0
        const detailVersion = detail?.seq ?? 0
        const watermark = Math.max(cachedVersion, detailVersion)
        if ((session.lastAssistantMessageVersion ?? 0) >= watermark) {
            return session
        }
        if (detail && detailVersion >= cachedVersion) {
            return {
                ...toSessionSummary(detail),
                // These fields are computed from the REST list's message
                // table and are not present in a full Session detail.
                futureScheduledMessageCount: session.futureScheduledMessageCount,
                nextScheduledAt: session.nextScheduledAt
            }
        }
        return cached ?? session
    })
    sessions.sort(sortSessionSummaries)
    return { ...incoming, sessions }
}
