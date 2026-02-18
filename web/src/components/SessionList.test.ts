import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    getUnreadLabelClass,
    groupSessionsByDirectory,
    loadSessionReadHistory,
    patchGroupsVisuals,
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
        }, new Set(), now)

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
        }, new Set(), now)

        expect(groups.map((group) => group.directory)).toEqual(['/repo-b', '/repo-a'])
    })

    it('bubbles unread sessions above recently read ones', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'active', active: true, updatedAt: 100 }),
            makeSession({ id: 'recent-read', updatedAt: 200 }),
            makeSession({ id: 'unread', updatedAt: 50 }),
        ]

        const groups = groupSessionsByDirectory(sessions, {
            'recent-read': now - 1_000,
        }, new Set(['unread']), now)

        expect(groups).toHaveLength(1)
        expect(groups[0]?.sessions.map((session) => session.id)).toEqual([
            'active',
            'unread',
            'recent-read',
        ])
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

describe('patchGroupsVisuals', () => {
    it('updates session data without changing order', () => {
        const s1 = makeSession({ id: 's1', active: false, updatedAt: 100 })
        const s2 = makeSession({ id: 's2', active: false, updatedAt: 200 })
        const frozenGroups = [{
            directory: '/repo',
            displayName: 'repo',
            sessions: [s1, s2],
            latestUpdatedAt: 200,
            latestReadAt: -Infinity,
            hasActiveSession: false
        }]

        const s1Updated = makeSession({ id: 's1', active: true, thinking: true, updatedAt: 300 })
        const patched = patchGroupsVisuals(frozenGroups, [s1Updated, s2], new Set())

        expect(patched[0]?.sessions.map(s => s.id)).toEqual(['s1', 's2'])
        expect(patched[0]?.sessions[0]?.active).toBe(true)
        expect(patched[0]?.sessions[0]?.thinking).toBe(true)
        expect(patched[0]?.hasActiveSession).toBe(true)
    })

    it('removes sessions that no longer exist', () => {
        const s1 = makeSession({ id: 's1', updatedAt: 100 })
        const s2 = makeSession({ id: 's2', updatedAt: 200 })
        const frozenGroups = [{
            directory: '/repo',
            displayName: 'repo',
            sessions: [s1, s2],
            latestUpdatedAt: 200,
            latestReadAt: -Infinity,
            hasActiveSession: false
        }]

        const patched = patchGroupsVisuals(frozenGroups, [s2], new Set())

        expect(patched[0]?.sessions.map(s => s.id)).toEqual(['s2'])
    })

    it('removes empty groups after session removal', () => {
        const s1 = makeSession({ id: 's1', metadata: { path: '/repo-a' } })
        const s2 = makeSession({ id: 's2', metadata: { path: '/repo-b' } })
        const frozenGroups = [
            {
                directory: '/repo-a',
                displayName: 'repo-a',
                sessions: [s1],
                latestUpdatedAt: 0,
                latestReadAt: -Infinity,
                hasActiveSession: false
            },
            {
                directory: '/repo-b',
                displayName: 'repo-b',
                sessions: [s2],
                latestUpdatedAt: 0,
                latestReadAt: -Infinity,
                hasActiveSession: false
            }
        ]

        const patched = patchGroupsVisuals(frozenGroups, [s2], new Set())

        expect(patched).toHaveLength(1)
        expect(patched[0]?.directory).toBe('/repo-b')
    })

    it('returns same reference when nothing changed', () => {
        const s1 = makeSession({ id: 's1', updatedAt: 100 })
        const frozenGroups = [{
            directory: '/repo',
            displayName: 'repo',
            sessions: [s1],
            latestUpdatedAt: 100,
            latestReadAt: -Infinity,
            hasActiveSession: false
        }]

        const patched = patchGroupsVisuals(frozenGroups, [s1], new Set())

        expect(patched).toBe(frozenGroups)
    })
})
