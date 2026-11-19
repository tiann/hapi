import { SessionScheduleSchema } from '@hapi/protocol/schemas'
import type { SessionsResponse, SessionSummary } from '@/types/api'

type CachedSessionSummary = SessionSummary & {
    sessionScheduleEventId?: string
    sessionListInsertionEventId?: string
}
export type CachedSessionsResponse = Omit<SessionsResponse, 'sessions'> & { sessions: CachedSessionSummary[] }

// Positions are comparable only within one hub epoch and namespace.
function comparePositions(a: string | undefined, b: string | undefined): number | undefined {
    const cursorPattern = /^([^:]+):(0|[1-9]\d*):([^:]+)$/
    const firstCursor = a?.match(cursorPattern)
    const secondCursor = b?.match(cursorPattern)
    if (!firstCursor || !secondCursor) return undefined
    const [, epoch, seq, namespace] = firstCursor
    const [, otherEpoch, otherSeq, otherNamespace] = secondCursor
    if (epoch !== otherEpoch || namespace !== otherNamespace) return undefined
    const first = Number(seq)
    const second = Number(otherSeq)
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return undefined
    return first - second
}

export function isNewerSessionListEvent(eventId: string | undefined, snapshotCursor: string | undefined): boolean {
    return (comparePositions(eventId, snapshotCursor) ?? 0) > 0
}

export function applySessionSchedule(
    previous: CachedSessionsResponse | undefined,
    sessionId: string,
    eventId: string,
    value: unknown,
    fetching: boolean
): CachedSessionsResponse | undefined {
    const schedule = SessionScheduleSchema.safeParse(value)
    if (!previous || !schedule.success) return undefined
    const index = previous.sessions.findIndex(row => row.id === sessionId)
    const row = previous.sessions[index]
    if (!row) return undefined

    const order = comparePositions(eventId, row.sessionScheduleEventId ?? previous.sessionScheduleCursor)
    if (order === undefined) return undefined
    if (order <= 0) return previous

    // While a GET is in flight, even an equal-value event may supersede the
    // server's intermediate snapshot (for example, schedule then cancel).
    if (!fetching
        && row.futureScheduledMessageCount === schedule.data.futureScheduledMessageCount
        && row.nextScheduledAt === schedule.data.nextScheduledAt) {
        return previous
    }

    const sessions = previous.sessions.slice()
    sessions[index] = { ...row, ...schedule.data, sessionScheduleEventId: eventId }
    return { ...previous, sessions }
}

export function reconcileSessionSchedule(
    snapshot: SessionSummary,
    snapshotCursor: string | undefined,
    cached: CachedSessionSummary | undefined
): CachedSessionSummary {
    if (!cached || !isNewerSessionListEvent(cached.sessionScheduleEventId, snapshotCursor)) {
        return snapshot
    }
    return {
        ...snapshot,
        futureScheduledMessageCount: cached.futureScheduledMessageCount,
        nextScheduledAt: cached.nextScheduledAt,
        sessionScheduleEventId: cached.sessionScheduleEventId
    }
}
