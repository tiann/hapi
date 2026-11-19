import { isHibernatedLifecycleState } from '@hapi/protocol/sessionLifecycle'
import type { SessionSummary } from '@/types/api'
import type { SessionListSort, SessionListView } from '@/hooks/useSessionListView'

type OrderFields = Pick<SessionSummary, 'id' | 'active' | 'createdAt' | 'lastUserMessageAt'>

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

/**
 * Active-view membership: connected sessions plus hibernated ones, which the
 * hub resumes transparently on the next send. Ordering, group activity and the
 * Active filter share this so a session keeps its place when it hibernates.
 */
export function isSessionActiveForList(session: Pick<SessionSummary, 'active' | 'metadata'>): boolean {
    return session.active || isHibernatedLifecycleState(session.metadata?.lifecycleState)
}

export type SessionComparator = (a: SessionSummary, b: SessionSummary) => number

export function createSessionComparator(view: Pick<SessionListView, 'sort' | 'activeFirst'>): SessionComparator {
    return (a, b) => {
        const aActive = isSessionActiveForList(a)
        const bActive = isSessionActiveForList(b)
        if (view.activeFirst && aActive !== bActive) return aActive ? -1 : 1
        return getSessionSortKey(b, view.sort) - getSessionSortKey(a, view.sort)
            || (b.createdAt ?? 0) - (a.createdAt ?? 0)
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }
}
