import type { QueryClient } from '@tanstack/react-query'
import { SessionScheduleSchema, type SessionSchedule } from '@hapi/protocol/schemas'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from './query-keys'

type CachedSessionSummary = SessionSummary & {
    sessionScheduleEventId?: string
    sessionListInsertionEventId?: string
}
export type CachedSessionsResponse = Omit<SessionsResponse, 'sessions'> & { sessions: CachedSessionSummary[] }

const cursorPattern = /^([^:]+):(0|[1-9]\d*):([^:]+)$/

// Positions are comparable only within one hub epoch and namespace.
function comparePositions(a: string | undefined, b: string | undefined): number | undefined {
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

type ScheduleUpdate = SessionSchedule & { sessionScheduleEventId?: string }
const initialSchedules = new WeakMap<QueryClient, {
    updates: Map<string, ScheduleUpdate>
    invalidated: boolean
}>()

function initialScheduleKey(sessionId: string, eventId: string | undefined): string | undefined {
    const cursor = eventId?.match(cursorPattern)
    if (!cursor || !Number.isSafeInteger(Number(cursor[2]))) return undefined
    return JSON.stringify([cursor[1], cursor[3], sessionId])
}

export function beginInitialSessionSchedules(client: QueryClient) {
    const updates = new Map<string, ScheduleUpdate>()
    const initial = { updates, invalidated: false }
    initialSchedules.set(client, initial)
    return {
        take: (id: string, snapshotCursor: string | undefined) => {
            const key = initialScheduleKey(id, snapshotCursor)
            if (key === undefined) return undefined
            const update = updates.get(key)
            updates.delete(key)
            return update
        },
        needsRecovery: () => initial.invalidated || updates.size > 0,
        close: () => {
            if (initialSchedules.get(client) === initial) initialSchedules.delete(client)
        }
    }
}

export function deferInitialSessionListInvalidation(client: QueryClient): boolean {
    const initial = initialSchedules.get(client)
    if (!initial || client.getQueryData(queryKeys.sessions) !== undefined) return false
    initial.invalidated = true
    return true
}

export function bufferInitialSessionSchedule(client: QueryClient, sessionId: string, eventId: string, value: unknown): boolean {
    const updates = initialSchedules.get(client)?.updates
    const key = initialScheduleKey(sessionId, eventId)
    if (!updates || key === undefined) return false
    const schedule = SessionScheduleSchema.safeParse(value)
    if (!schedule.success) return false

    const previous = updates.get(key)
    if (!previous || isNewerSessionListEvent(eventId, previous.sessionScheduleEventId)) {
        updates.set(key, { ...schedule.data, sessionScheduleEventId: eventId })
    }
    return true
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
    cached: ScheduleUpdate | undefined
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
