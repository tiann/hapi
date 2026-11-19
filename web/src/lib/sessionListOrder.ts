import type { SessionSummary } from '@/types/api'
import type { SessionListSort, SessionListView } from '@/hooks/useSessionListView'

type OrderFields = Pick<SessionSummary, 'id' | 'active' | 'createdAt' | 'lastUserMessageAt'>

// Bulk transitions (a hub restart or upgrade) touch many sessions seconds
// apart; within one minute they keep the chosen sort instead of write order.
const LAST_ACTIVITY_BUCKET_MS = 60_000

/**
 * A stopped session's last activity, to the minute: `updatedAt`, the time its
 * row shows. Archiving a session updates it, and it reaches the list on every
 * session patch, so the order always matches what the rows say.
 */
function lastActivityBucket(session: Pick<SessionSummary, 'updatedAt'>): number {
    return Math.floor((session.updatedAt ?? 0) / LAST_ACTIVITY_BUCKET_MS)
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
            // Stopped and archived sessions follow the time their rows show, so
            // one archived just now comes first. Archiving is not a user
            // message, so the chosen sort alone would leave it mid-block.
            if (!a.active) {
                const recent = lastActivityBucket(b) - lastActivityBucket(a)
                if (recent !== 0) return recent
            }
        }
        return getSessionSortKey(b, view.sort) - getSessionSortKey(a, view.sort)
            || (b.createdAt ?? 0) - (a.createdAt ?? 0)
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }
}
