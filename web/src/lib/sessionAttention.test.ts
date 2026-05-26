import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { classifySessionAttention } from './sessionAttention'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 1000,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        backgroundTaskCount: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('classifySessionAttention', () => {
    it('returns null for the selected session', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', pendingRequestKinds: ['permission'] }),
            { selected: true, lastSeenAt: 0 }
        )
        expect(attention).toBeNull()
    })

    it('prioritizes permission over unread activity', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'a',
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                updatedAt: 5000
            }),
            { selected: false, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('shows unread activity when the session has updated since last seen', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', updatedAt: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('shows background work without treating it as unread', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', backgroundTaskCount: 2, updatedAt: 5000 }),
            { selected: false, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'background' })
    })
})
