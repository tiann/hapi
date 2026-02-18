import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    getUnreadLabelClass,
    groupSessionsByDirectory,
    loadSessionReadHistory,
    pruneSessionReadHistory,
    saveSessionReadHistory
} from './SessionList'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    const { id, ...rest } = overrides
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: {
            path: '/repo'
        },
        todoProgress: null,
        pendingRequestsCount: 0,
        ...rest
    }
}

describe('SessionList helpers', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('prioritizes active sessions, then recently read sessions, then updatedAt', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'active', active: true, updatedAt: 100 }),
            makeSession({ id: 'recent-read', updatedAt: 200 }),
            makeSession({ id: 'latest-updated', updatedAt: 300 }),
        ]

        const groups = groupSessionsByDirectory(sessions, {
            'recent-read': now - 1_000,
        }, now)

        expect(groups).toHaveLength(1)
        expect(groups[0]?.sessions.map((session) => session.id)).toEqual([
            'active',
            'recent-read',
            'latest-updated'
        ])
    })

    it('sorts groups by recent reads when no active sessions', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/repo-b' }, updatedAt: 200 })
        ]

        const groups = groupSessionsByDirectory(sessions, {
            b: now - 1_000
        }, now)

        expect(groups.map((group) => group.directory)).toEqual(['/repo-b', '/repo-a'])
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
