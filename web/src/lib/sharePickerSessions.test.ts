import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    countHiddenActiveSharePickerSessions,
    filterSharePickerSessions,
    SHARE_PICKER_ACTIVE_LIMIT,
} from './sharePickerSessions'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides,
    }
}

const machineLabel = () => 'desktop'

describe('filterSharePickerSessions', () => {
    it('returns active sessions sorted by updatedAt when query is empty', () => {
        const sessions = [
            makeSession({ id: 'old-active', active: true, updatedAt: 100 }),
            makeSession({ id: 'inactive-recent', active: false, updatedAt: 300 }),
            makeSession({ id: 'new-active', active: true, updatedAt: 200 }),
        ]
        const result = filterSharePickerSessions(sessions, '', machineLabel)
        expect(result.map((s) => s.id)).toEqual(['new-active', 'old-active'])
    })

    it('caps active sessions when query is empty', () => {
        const sessions = Array.from({ length: SHARE_PICKER_ACTIVE_LIMIT + 3 }, (_, index) =>
            makeSession({ id: `s-${index}`, active: true, updatedAt: index }))
        const result = filterSharePickerSessions(sessions, '', machineLabel)
        expect(result).toHaveLength(SHARE_PICKER_ACTIVE_LIMIT)
        expect(result[0].id).toBe(`s-${SHARE_PICKER_ACTIVE_LIMIT + 2}`)
    })

    it('searches all sessions including inactive when query is non-empty', () => {
        const sessions = [
            makeSession({
                id: 'inactive-match',
                active: false,
                updatedAt: 50,
                metadata: { path: '/proj/archive', summary: { text: 'Old bugfix' } },
            }),
            makeSession({ id: 'active-no-match', active: true, updatedAt: 200, metadata: { path: '/other' } }),
        ]
        const result = filterSharePickerSessions(sessions, 'archive', machineLabel)
        expect(result.map((s) => s.id)).toEqual(['inactive-match'])
    })

    it('matches machine label in search mode', () => {
        const sessions = [
            makeSession({
                id: 'remote',
                active: false,
                updatedAt: 100,
                metadata: { path: '/proj', machineId: 'machine-abc' },
            }),
        ]
        const result = filterSharePickerSessions(
            sessions,
            'laptop',
            (machineId) => (machineId === 'machine-abc' ? 'dev-laptop' : 'unknown'),
        )
        expect(result.map((s) => s.id)).toEqual(['remote'])
    })
})

describe('countHiddenActiveSharePickerSessions', () => {
    it('returns zero when active count is within cap', () => {
        const sessions = [
            makeSession({ id: 'a', active: true }),
            makeSession({ id: 'b', active: false }),
        ]
        expect(countHiddenActiveSharePickerSessions(sessions)).toBe(0)
    })

    it('counts active sessions beyond the cap', () => {
        const sessions = Array.from({ length: SHARE_PICKER_ACTIVE_LIMIT + 2 }, (_, index) =>
            makeSession({ id: `s-${index}`, active: true }))
        expect(countHiddenActiveSharePickerSessions(sessions)).toBe(2)
    })
})
