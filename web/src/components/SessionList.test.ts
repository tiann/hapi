import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    FLAT_DIRECTORY_KEY,
    computeFreezeStep,
    flattenSessions,
    getSessionIdHash,
    getUnreadLabelClass,
    groupSessionsByDirectory,
    loadSessionReadHistory,
    patchGroupsVisuals,
    pruneSessionReadHistory,
    saveSessionReadHistory,
    sortSessionsByPriority,
    type FreezeState
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

describe('sortSessionsByPriority', () => {
    it('sorts pending, finished unread, in-progress unread, then everything else', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'other-old', updatedAt: 10 }),
            makeSession({ id: 'pending-old', pendingRequestsCount: 1, updatedAt: 100 }),
            makeSession({ id: 'in-progress-active', active: true, updatedAt: 140 }),
            makeSession({ id: 'finished-unread', updatedAt: 150 }),
            makeSession({ id: 'pending-new', active: true, thinking: true, pendingRequestsCount: 2, updatedAt: 200 }),
            makeSession({ id: 'in-progress-thinking', thinking: true, updatedAt: 160 }),
            makeSession({ id: 'other-new', updatedAt: 300 }),
        ]
        const unreadSessionIds = new Set<string>(['finished-unread', 'in-progress-active', 'in-progress-thinking'])

        const sorted = sortSessionsByPriority(sessions, {}, unreadSessionIds, now)

        expect(sorted.map(session => session.id)).toEqual([
            'pending-new',
            'pending-old',
            'finished-unread',
            'in-progress-thinking',
            'in-progress-active',
            'other-new',
            'other-old',
        ])
    })

    it('uses updatedAt desc for ties and id asc as deterministic fallback', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'unread-b', updatedAt: 100 }),
            makeSession({ id: 'unread-a', updatedAt: 100 }),
            makeSession({ id: 'unread-c', updatedAt: 200 }),
        ]

        const sorted = sortSessionsByPriority(sessions, {}, new Set(['unread-a', 'unread-b', 'unread-c']))

        expect(sorted.map(session => session.id)).toEqual(['unread-c', 'unread-a', 'unread-b'])
    })

    it('ignores readHistory when ranks match', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'read-newer', updatedAt: 100 }),
            makeSession({ id: 'read-older', updatedAt: 100 }),
        ]

        const sorted = sortSessionsByPriority(sessions, {
            'read-newer': now - 1_000,
            'read-older': now - 2_000
        }, new Set(), now)

        expect(sorted.map(session => session.id)).toEqual(['read-newer', 'read-older'])
    })

    it('returns empty array for empty input', () => {
        expect(sortSessionsByPriority([], {}, new Set())).toEqual([])
    })

    it('does not mutate the input array', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'a', updatedAt: 100 }),
            makeSession({ id: 'b', updatedAt: 200 }),
        ]

        const inputOrder = sessions.map(session => session.id)

        sortSessionsByPriority(sessions, {}, new Set(), 1_800_000_000_000)

        expect(sessions.map(session => session.id)).toEqual(inputOrder)
    })
})

describe('flattenSessions', () => {
    it('returns empty array for empty sessions', () => {
        expect(flattenSessions([], {})).toEqual([])
    })

    it('returns single group with directory FLAT_DIRECTORY_KEY', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' } }),
            makeSession({ id: 'b', metadata: { path: '/repo-b' } }),
        ]

        const groups = flattenSessions(sessions, {})

        expect(groups).toHaveLength(1)
        expect(groups[0]?.directory).toBe(FLAT_DIRECTORY_KEY)
    })

    it('sorts globally by rank across directories', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'stale', metadata: { path: '/repo-c' }, updatedAt: 100 }),
            makeSession({ id: 'active', metadata: { path: '/repo-a' }, active: true, updatedAt: 50 }),
            makeSession({ id: 'unread', metadata: { path: '/repo-b' }, updatedAt: 200 }),
        ]

        const groups = flattenSessions(sessions, {}, new Set(['unread']), now)

        expect(groups[0]?.sessions.map(session => session.id)).toEqual(['unread', 'stale', 'active'])
    })

    it('uses sortSessionsByPriority for ordering', () => {
        const now = 1_800_000_000_000
        const olderRead = now - (5 * 24 * 60 * 60 * 1000)
        const newerRead = now - (4 * 24 * 60 * 60 * 1000)
        const sessions: SessionSummary[] = [
            makeSession({ id: 'older-read', metadata: { path: '/repo-a' }, updatedAt: 100 }),
            makeSession({ id: 'newer-read', metadata: { path: '/repo-b' }, updatedAt: 100 }),
            makeSession({ id: 'higher-updated', metadata: { path: '/repo-c' }, updatedAt: 300 }),
        ]

        const groups = flattenSessions(sessions, {
            'older-read': olderRead,
            'newer-read': newerRead,
        }, new Set(), now)

        expect(groups[0]?.sessions.map(session => session.id)).toEqual([
            'higher-updated',
            'newer-read',
            'older-read',
        ])
    })

    it('sets hasActiveSession correctly', () => {
        const withActive = flattenSessions([
            makeSession({ id: 'active', active: true }),
            makeSession({ id: 'inactive' }),
        ], {})
        expect(withActive[0]?.hasActiveSession).toBe(true)

        const withoutActive = flattenSessions([
            makeSession({ id: 'inactive-a' }),
            makeSession({ id: 'inactive-b' }),
        ], {})
        expect(withoutActive[0]?.hasActiveSession).toBe(false)
    })

    it('computes latestUpdatedAt and latestReadAt across all sessions', () => {
        const sessions: SessionSummary[] = [
            makeSession({ id: 's1', updatedAt: 100 }),
            makeSession({ id: 's2', updatedAt: 500 }),
            makeSession({ id: 's3', updatedAt: 300 }),
        ]
        const readHistory = {
            s1: 200,
            s3: 700,
        }

        const groups = flattenSessions(sessions, readHistory)

        expect(groups[0]?.latestUpdatedAt).toBe(500)
        expect(groups[0]?.latestReadAt).toBe(700)
    })
})

describe('SessionList helpers', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('sorts non-unread sessions by updatedAt regardless of active/read state', () => {
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
            'latest-updated',
            'recent-read',
            'active'
        ])
    })

    it('sorts groups by highest-priority session bucket', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'pending', metadata: { path: '/repo-pending' }, pendingRequestsCount: 1, updatedAt: 10 }),
            makeSession({ id: 'finished-unread', metadata: { path: '/repo-finished' }, updatedAt: 20 }),
            makeSession({ id: 'in-progress-unread', metadata: { path: '/repo-inprogress' }, active: true, updatedAt: 30 }),
            makeSession({ id: 'other', metadata: { path: '/repo-other' }, updatedAt: 40 }),
        ]

        const groups = groupSessionsByDirectory(
            sessions,
            {},
            new Set(['finished-unread', 'in-progress-unread']),
            now
        )

        expect(groups.map((group) => group.directory)).toEqual([
            '/repo-pending',
            '/repo-finished',
            '/repo-inprogress',
            '/repo-other',
        ])
    })

    it('breaks group ties by latestUpdatedAt desc, then directory asc', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'repo-c', metadata: { path: '/repo-c' }, updatedAt: 300 }),
            makeSession({ id: 'repo-b', metadata: { path: '/repo-b' }, updatedAt: 200 }),
            makeSession({ id: 'repo-a', metadata: { path: '/repo-a' }, updatedAt: 200 }),
        ]

        const groups = groupSessionsByDirectory(
            sessions,
            { 'repo-b': now - 1_000 },
            new Set(),
            now
        )

        expect(groups.map((group) => group.directory)).toEqual([
            '/repo-c',
            '/repo-a',
            '/repo-b',
        ])
    })

    it('puts finished unread above in-progress unread sessions', () => {
        const now = 1_800_000_000_000
        const sessions: SessionSummary[] = [
            makeSession({ id: 'in-progress-unread', active: true, updatedAt: 100 }),
            makeSession({ id: 'recent-read', updatedAt: 200 }),
            makeSession({ id: 'finished-unread', updatedAt: 50 }),
        ]

        const groups = groupSessionsByDirectory(sessions, {
            'recent-read': now - 1_000,
        }, new Set(['in-progress-unread', 'finished-unread']), now)

        expect(groups).toHaveLength(1)
        expect(groups[0]?.sessions.map((session) => session.id)).toEqual([
            'finished-unread',
            'in-progress-unread',
            'recent-read'
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
        const patched = patchGroupsVisuals(frozenGroups, [s1Updated, s2])

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

        const patched = patchGroupsVisuals(frozenGroups, [s2])

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

        const patched = patchGroupsVisuals(frozenGroups, [s2])

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

        const patched = patchGroupsVisuals(frozenGroups, [s1])

        expect(patched).toBe(frozenGroups)
    })
})

describe('computeFreezeStep', () => {
    const group = (sessions: SessionSummary[]) => ({
        directory: '/repo',
        displayName: 'repo',
        sessions,
        latestUpdatedAt: 0,
        latestReadAt: -Infinity,
        hasActiveSession: false
    })

    function initialState(sessions: SessionSummary[]): FreezeState {
        return {
            frozenGroups: null,
            prevSelectedSessionId: null,
            prevSessionIdHash: getSessionIdHash(sessions),
            prevViewKey: 'grouped',
            unfreezeCount: 0,
            selectionFreezeArmed: false
        }
    }

    it('freezes while selected, then releases on deselect', () => {
        const s1 = makeSession({ id: 's1' })
        const s2 = makeSession({ id: 's2' })
        const liveGroups = [group([s1, s2])]
        const sessions = [s1, s2]

        // Initial: select s1 from null → freeze in place.
        const r1 = computeFreezeStep(initialState(sessions), liveGroups, 's1', sessions, 'grouped')
        expect(r1.unfreezeCount).toBe(0)
        expect(r1.selectionFreezeArmed).toBe(true)

        // Next stable render while still selected → remain frozen.
        const r2 = computeFreezeStep(r1, liveGroups, 's1', sessions, 'grouped')
        expect(r2.unfreezeCount).toBe(0)
        expect(r2.selectionFreezeArmed).toBe(true)

        // Switch to s2 → freeze again.
        const r3 = computeFreezeStep(r2, liveGroups, 's2', sessions, 'grouped')
        expect(r3.unfreezeCount).toBe(0)
        expect(r3.selectionFreezeArmed).toBe(true)

        // Next stable render for s2 while still selected → remain frozen.
        const r4 = computeFreezeStep(r3, liveGroups, 's2', sessions, 'grouped')
        expect(r4.unfreezeCount).toBe(0)
        expect(r4.selectionFreezeArmed).toBe(true)

        // Deselect → release and re-sort
        const r5 = computeFreezeStep(r4, liveGroups, null, sessions, 'grouped')
        expect(r5.unfreezeCount).toBe(1)
    })

    it('unfreezes when session ID set changes (same count replacement)', () => {
        const s1 = makeSession({ id: 's1' })
        const s2 = makeSession({ id: 's2' })
        const s3 = makeSession({ id: 's3' })

        const sessions12 = [s1, s2]
        const sessions13 = [s1, s3]

        // Initial selection freezes without incrementing
        const r1 = computeFreezeStep(initialState(sessions12), [group(sessions12)], 's1', sessions12, 'grouped')
        expect(r1.unfreezeCount).toBe(0)

        // Same selection, same count but different IDs (s2 replaced by s3) → unfreezes
        const r2 = computeFreezeStep(r1, [group(sessions13)], 's1', sessions13, 'grouped')
        expect(r2.unfreezeCount).toBe(1)
    })

    it('keeps freeze while selected even when only session data changes', () => {
        const s1 = makeSession({ id: 's1', active: false })
        const s1Active = makeSession({ id: 's1', active: true })
        const sessions = [s1]
        const sessionsUpdated = [s1Active]

        // Initial selection freezes without incrementing
        const r1 = computeFreezeStep(initialState(sessions), [group(sessions)], 's1', sessions, 'grouped')
        expect(r1.unfreezeCount).toBe(0)
        expect(r1.selectionFreezeArmed).toBe(true)

        // Next render while still selected keeps order frozen but patches visuals.
        const r2 = computeFreezeStep(r1, [group(sessionsUpdated)], 's1', sessionsUpdated, 'grouped')
        expect(r2.unfreezeCount).toBe(0)
        expect(r2.displayGroups[0]?.sessions[0]?.active).toBe(true)
        expect(r2.selectionFreezeArmed).toBe(true)
    })

    it('passes through liveGroups when no session is selected', () => {
        const s1 = makeSession({ id: 's1' })
        const sessions = [s1]
        const liveGroups = [group(sessions)]

        const r1 = computeFreezeStep(initialState(sessions), liveGroups, null, sessions, 'grouped')
        expect(r1.displayGroups).toBe(liveGroups)

        // New liveGroups reference → passes through immediately
        const liveGroups2 = [group(sessions)]
        const r2 = computeFreezeStep(r1, liveGroups2, null, sessions, 'grouped')
        expect(r2.displayGroups).toBe(liveGroups2)
    })

    it('unfreezes when deselecting (selection → null)', () => {
        const s1 = makeSession({ id: 's1' })
        const sessions = [s1]
        const liveGroups = [group(sessions)]

        // Initial selection freezes without incrementing
        const r1 = computeFreezeStep(initialState(sessions), liveGroups, 's1', sessions, 'grouped')
        expect(r1.unfreezeCount).toBe(0)

        // Deselect → unfreezes
        const r2 = computeFreezeStep(r1, liveGroups, null, sessions, 'grouped')
        expect(r2.unfreezeCount).toBe(1)
        expect(r2.selectionFreezeArmed).toBe(false)
    })

    it('stays frozen on same-tick selection + rank-driving session update', () => {
        const s1 = makeSession({ id: 's1', active: false, updatedAt: 100 })
        const s2 = makeSession({ id: 's2', active: false, updatedAt: 200 })
        const sessionsBefore = [s1, s2]
        const liveBefore = [group([s2, s1])]

        // Baseline render: no selection.
        const r0 = computeFreezeStep(initialState(sessionsBefore), liveBefore, null, sessionsBefore, 'grouped')
        expect(r0.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2', 's1'])

        // Same tick: select s1 while session data changes enough to re-rank s1 first in liveGroups.
        const s1Active = makeSession({ id: 's1', active: true, updatedAt: 300 })
        const sessionsAfter = [s1Active, s2]
        const liveAfter = [group([s1Active, s2])]
        const r1 = computeFreezeStep(r0, liveAfter, 's1', sessionsAfter, 'grouped')

        // Still frozen; keep pre-click order but patch visuals.
        expect(r1.unfreezeCount).toBe(0)
        expect(r1.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2', 's1'])
        expect(r1.displayGroups[0]?.sessions[1]?.active).toBe(true)
    })

    it('stays frozen on session switch + same-tick rank-driving update', () => {
        const s1 = makeSession({ id: 's1', active: false, updatedAt: 100 })
        const s2 = makeSession({ id: 's2', active: false, updatedAt: 200 })
        const sessionsBefore = [s1, s2]
        const liveBefore = [group([s2, s1])]

        const r0 = computeFreezeStep(initialState(sessionsBefore), liveBefore, null, sessionsBefore, 'grouped')
        const r1 = computeFreezeStep(r0, liveBefore, 's1', sessionsBefore, 'grouped')
        expect(r1.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2', 's1'])
        expect(r1.selectionFreezeArmed).toBe(true)

        // Same tick: switch selection to s2 while live order would flip.
        const s1Bumped = makeSession({ id: 's1', active: false, updatedAt: 500 })
        const sessionsAfter = [s1Bumped, s2]
        const liveAfter = [group([s1Bumped, s2])]
        const r2 = computeFreezeStep(r1, liveAfter, 's2', sessionsAfter, 'grouped')

        expect(r2.unfreezeCount).toBe(0)
        expect(r2.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2', 's1'])
        expect(r2.displayGroups[0]?.sessions[1]?.updatedAt).toBe(500)
        expect(r2.selectionFreezeArmed).toBe(true)

        // Stable render for s2 while selected stays frozen.
        const r3 = computeFreezeStep(r2, liveAfter, 's2', sessionsAfter, 'grouped')
        expect(r3.unfreezeCount).toBe(0)
        expect(r3.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2', 's1'])
        expect(r3.selectionFreezeArmed).toBe(true)
    })

    it('stays frozen and patches visuals while selected', () => {
        const s1 = makeSession({ id: 's1', active: false, updatedAt: 100 })
        const s2 = makeSession({ id: 's2', active: false, updatedAt: 200 })
        const sessionsBefore = [s1, s2]
        const liveBefore = [group([s2, s1])]

        const r0 = computeFreezeStep(initialState(sessionsBefore), liveBefore, null, sessionsBefore, 'grouped')
        const r1 = computeFreezeStep(r0, liveBefore, 's1', sessionsBefore, 'grouped')
        expect(r1.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2', 's1'])
        expect(r1.selectionFreezeArmed).toBe(true)

        // While still selected, active status would move s1 to top in liveGroups.
        const s1Active = makeSession({ id: 's1', active: true, updatedAt: 300 })
        const sessionsAfter = [s1Active, s2]
        const liveAfter = [group([s1Active, s2])]
        const r2 = computeFreezeStep(r1, liveAfter, 's1', sessionsAfter, 'grouped')

        expect(r2.unfreezeCount).toBe(0)
        expect(r2.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2', 's1'])
        expect(r2.displayGroups[0]?.sessions[1]?.active).toBe(true)
        expect(r2.selectionFreezeArmed).toBe(true)
    })

    it('unfreezes when selected session is removed', () => {
        const s1 = makeSession({ id: 's1' })
        const s2 = makeSession({ id: 's2' })
        const sessionsBefore = [s1, s2]
        const liveBefore = [group([s1, s2])]

        const r1 = computeFreezeStep(initialState(sessionsBefore), liveBefore, 's1', sessionsBefore, 'grouped')
        expect(r1.unfreezeCount).toBe(0)

        const sessionsAfter = [s2]
        const liveAfter = [group([s2])]
        const r2 = computeFreezeStep(r1, liveAfter, 's1', sessionsAfter, 'grouped')

        expect(r2.unfreezeCount).toBe(1)
        expect(r2.displayGroups).toBe(liveAfter)
        expect(r2.displayGroups[0]?.sessions.map(s => s.id)).toEqual(['s2'])
    })

    it('treats undefined and null as equivalent no-selection states', () => {
        const s1 = makeSession({ id: 's1' })
        const sessions = [s1]
        const liveGroups = [group(sessions)]

        const r1 = computeFreezeStep(initialState(sessions), liveGroups, undefined, sessions, 'grouped')
        expect(r1.unfreezeCount).toBe(0)

        const r2 = computeFreezeStep(r1, liveGroups, null, sessions, 'grouped')
        expect(r2.unfreezeCount).toBe(0)

        const r3 = computeFreezeStep(r2, liveGroups, undefined, sessions, 'grouped')
        expect(r3.unfreezeCount).toBe(0)
    })

    it('works with flat single-group input', () => {
        const s1 = makeSession({ id: 's1', active: true, updatedAt: 200 })
        const s2 = makeSession({ id: 's2', updatedAt: 100 })
        const sessions = [s1, s2]
        const flatGroups = [{
            directory: FLAT_DIRECTORY_KEY,
            displayName: '',
            sessions,
            latestUpdatedAt: 200,
            latestReadAt: -Infinity,
            hasActiveSession: true
        }]
        const state: FreezeState = {
            frozenGroups: null,
            prevSelectedSessionId: null,
            prevSessionIdHash: getSessionIdHash(sessions),
            prevViewKey: 'flat',
            unfreezeCount: 0,
            selectionFreezeArmed: false
        }

        const r1 = computeFreezeStep(state, flatGroups, 's1', sessions, 'flat')
        expect(r1.displayGroups[0]?.directory).toBe(FLAT_DIRECTORY_KEY)

        const r2 = computeFreezeStep(r1, flatGroups, null, sessions, 'flat')
        expect(r2.unfreezeCount).toBe(1)
        expect(r2.displayGroups[0]?.directory).toBe(FLAT_DIRECTORY_KEY)
    })

    it('force unfreezes when viewKey changes', () => {
        const s1 = makeSession({ id: 's1' })
        const sessions = [s1]
        const liveGroups = [group(sessions)]
        const state: FreezeState = {
            frozenGroups: liveGroups,
            prevSelectedSessionId: 's1',
            prevSessionIdHash: getSessionIdHash(sessions),
            prevViewKey: 'grouped',
            unfreezeCount: 0,
            selectionFreezeArmed: false
        }

        const result = computeFreezeStep(state, liveGroups, 's1', sessions, 'flat')

        expect(result.unfreezeCount).toBe(1)
        expect(result.selectionFreezeArmed).toBe(false)
        expect(result.displayGroups).toBe(liveGroups)
    })

    it('does not unfreeze on same viewKey', () => {
        const s1 = makeSession({ id: 's1' })
        const sessions = [s1]
        const liveGroups = [group(sessions)]
        const state: FreezeState = {
            frozenGroups: liveGroups,
            prevSelectedSessionId: 's1',
            prevSessionIdHash: getSessionIdHash(sessions),
            prevViewKey: 'grouped',
            unfreezeCount: 0,
            selectionFreezeArmed: false
        }

        const result = computeFreezeStep(state, liveGroups, 's1', sessions, 'grouped')

        expect(result.unfreezeCount).toBe(0)
        expect(result.selectionFreezeArmed).toBe(true)
    })
})
