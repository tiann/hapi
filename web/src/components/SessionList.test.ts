import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import {
    FLAT_DIRECTORY_KEY,
    applyOptimisticSortOrderUpdates,
    applySortOrderUpdatesToSessions,
    buildSortOrderUpdatesForReorder,
    flattenSessions,
    getSessionSortOrder,
    getUnreadLabelClass,
    groupSessionsByDirectory,
    loadSessionReadHistory,
    pruneSessionReadHistory,
    saveSessionReadHistory,
    sortSessionsBySortOrder,
} from './SessionList'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    const { id, ...rest } = overrides
    const base: SessionSummary = {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        sortOrder: null,
        metadata: {
            path: '/repo'
        },
        todoProgress: null,
        pendingRequestsCount: 0
    }

    return {
        ...base,
        ...rest,
        id,
    }
}

describe('sortSessionsBySortOrder', () => {
    it('sorts by sortOrder asc, null last, id tie-breaker', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'c', sortOrder: 'b' }),
            makeSession({ id: 'a', sortOrder: 'a' }),
            makeSession({ id: 'b', sortOrder: 'a' }),
            makeSession({ id: 'z', sortOrder: null }),
            makeSession({ id: 'y', sortOrder: null }),
        ]

        const sorted = sortSessionsBySortOrder(sessions)

        expect(sorted.map(session => session.id)).toEqual(['a', 'b', 'c', 'y', 'z'])
    })

    it('does not mutate input array', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'a', sortOrder: 'b' }),
            makeSession({ id: 'b', sortOrder: 'a' }),
        ]

        sortSessionsBySortOrder(sessions)

        expect(sessions.map(session => session.id)).toEqual(['a', 'b'])
    })

    it('uses lexicographic comparison for base62 keys (not locale-aware compare)', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'lower', sortOrder: 'a' }),
            makeSession({ id: 'upper', sortOrder: 'Z' }),
        ]

        const sorted = sortSessionsBySortOrder(sessions)

        expect(sorted.map(session => session.id)).toEqual(['upper', 'lower'])
    })
})

describe('group + flat ordering', () => {
    it('orders groups by min sortOrder and sessions within group by sortOrder', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'a2', sortOrder: 'c', metadata: { path: '/repo-a' } }),
            makeSession({ id: 'a1', sortOrder: 'b', metadata: { path: '/repo-a' } }),
            makeSession({ id: 'b1', sortOrder: 'a', metadata: { path: '/repo-b' } }),
        ]

        const groups = groupSessionsByDirectory(sessions, {})

        expect(groups.map(group => group.directory)).toEqual(['/repo-b', '/repo-a'])
        expect(groups[1]?.sessions.map(session => session.id)).toEqual(['a1', 'a2'])
    })

    it('flat view reorders globally by sortOrder', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'repo-c', sortOrder: 'm', metadata: { path: '/repo-c' } }),
            makeSession({ id: 'repo-a', sortOrder: 'a', metadata: { path: '/repo-a' } }),
            makeSession({ id: 'repo-b', sortOrder: 'k', metadata: { path: '/repo-b' } }),
        ]

        const groups = flattenSessions(sessions, {})

        expect(groups).toHaveLength(1)
        expect(groups[0]?.directory).toBe(FLAT_DIRECTORY_KEY)
        expect(groups[0]?.sessions.map(session => session.id)).toEqual(['repo-a', 'repo-b', 'repo-c'])
    })

    it('orders groups by lexicographic min sortOrder (base62-safe)', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'lower', sortOrder: 'a', metadata: { path: '/repo-lower' } }),
            makeSession({ id: 'upper', sortOrder: 'Z', metadata: { path: '/repo-upper' } }),
        ]

        const groups = groupSessionsByDirectory(sessions, {})

        expect(groups.map(group => group.directory)).toEqual(['/repo-upper', '/repo-lower'])
    })
})

describe('reorder helpers', () => {
    it('computes moved-session sortOrder between neighbors', () => {
        const a = makeSession({ id: 'a', sortOrder: 'a' })
        const b = makeSession({ id: 'b', sortOrder: 'b' })
        const c = makeSession({ id: 'c', sortOrder: 'c' })

        const updates = buildSortOrderUpdatesForReorder([a, c, b], 'c')

        expect(updates).toHaveLength(1)
        expect(updates[0]?.sessionId).toBe('c')

        const nextSortOrder = updates[0]?.sortOrder
        expect(nextSortOrder).not.toBeNull()
        expect(nextSortOrder! > getSessionSortOrder(a)!).toBe(true)
        expect(nextSortOrder! < getSessionSortOrder(b)!).toBe(true)
    })

    it('applies and rolls back optimistic updates', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })

        const initial: SessionsResponse = {
            sessions: [
                makeSession({ id: 'a', sortOrder: 'a' }),
                makeSession({ id: 'b', sortOrder: 'b' }),
            ]
        }

        queryClient.setQueryData(queryKeys.sessions, initial)

        const rollback = applyOptimisticSortOrderUpdates(queryClient, [
            { sessionId: 'b', sortOrder: 'aa' }
        ])

        const optimistic = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
        expect(optimistic?.sessions.find(session => session.id === 'b')?.sortOrder).toBe('aa')

        rollback()

        const restored = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
        expect(restored).toEqual(initial)
    })

    it('applySortOrderUpdatesToSessions returns same reference on no updates', () => {
        const sessions = [
            makeSession({ id: 'a', sortOrder: 'a' })
        ]

        expect(applySortOrderUpdatesToSessions(sessions, [])).toBe(sessions)
    })
})

describe('SessionList helpers', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('prunes stale session IDs from read history', () => {
        const next = pruneSessionReadHistory(
            {
                keep: 10,
                remove: 20
            },
            new Set(['keep'])
        )

        expect(next).toEqual({ keep: 10 })
    })

    it('persists and loads read history from localStorage', () => {
        saveSessionReadHistory({ s1: 123, s2: 456 })

        expect(loadSessionReadHistory()).toEqual({ s1: 123, s2: 456 })
    })

    it('uses subdued unread style while thinking', () => {
        expect(getUnreadLabelClass(true)).toContain('opacity-70')
        expect(getUnreadLabelClass(false)).toBe('text-[#34C759]')
    })
})
