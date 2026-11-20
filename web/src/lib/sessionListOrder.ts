import type { SessionSummary } from '@/types/api'
import type { SessionListSort, SessionListView } from '@/hooks/useSessionListView'

type OrderFields = Pick<SessionSummary, 'id' | 'active' | 'createdAt' | 'lastUserMessageAt'>

// Sessions that stop together (a hub restart or upgrade) disconnect seconds
// apart; within one minute they keep the chosen sort instead of keepalive order.
const STOPPED_AT_BUCKET_MS = 60_000

/**
 * The time a disconnected session's row shows and is ordered by: when it
 * stopped (`activeAt`, its last time connected, which the hub sends with every
 * stop) or its last update after that, whichever is later. Ordering and the
 * row's relative time use the same value, so they always agree.
 */
export function getStoppedSessionTime(session: Pick<SessionSummary, 'activeAt' | 'updatedAt'>): number {
    return Math.max(session.activeAt ?? 0, session.updatedAt ?? 0)
}

function stoppedAtBucket(session: Pick<SessionSummary, 'activeAt' | 'updatedAt'>): number {
    return Math.floor(getStoppedSessionTime(session) / STOPPED_AT_BUCKET_MS)
}

/**
 * - last-message: the user's latest prompt, falling back to creation (the
 *   long-standing default, which agent output never reorders).
 * - created: newest sessions first.
 */
export function getSessionSortKey(session: OrderFields, sort: SessionListSort): number {
    return sort === 'created'
        ? session.createdAt ?? 0
        : session.lastUserMessageAt ?? session.createdAt ?? 0
}

export type SessionComparator = (a: SessionSummary, b: SessionSummary) => number

export function createSessionComparator(view: Pick<SessionListView, 'sort' | 'activeFirst'>): SessionComparator {
    return (a, b) => {
        if (view.activeFirst) {
            if (a.active !== b.active) return a.active ? -1 : 1
            // Stopped and archived sessions: the one stopped most recently comes
            // first. Stopping is not a user message, so the chosen sort alone
            // would leave it mid-block.
            if (!a.active) {
                const stopped = stoppedAtBucket(b) - stoppedAtBucket(a)
                if (stopped !== 0) return stopped
            }
        }
        return getSessionSortKey(b, view.sort) - getSessionSortKey(a, view.sort)
            || (b.createdAt ?? 0) - (a.createdAt ?? 0)
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }
}
