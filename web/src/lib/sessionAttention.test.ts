import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    classifySessionAttention,
    sessionIsUnread,
} from './sessionAttention'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 1000,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
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

    it('handles summaries from older APIs without pendingRequestKinds', () => {
        const legacySummary = makeSummary({ id: 'legacy', updatedAt: 5000 }) as unknown as SessionSummary
        delete (legacySummary as Partial<SessionSummary>).pendingRequestKinds

        const attention = classifySessionAttention(
            legacySummary,
            { selected: false, lastSeenAt: 1000 }
        )

        expect(attention).toEqual({ kind: 'unread' })
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

    it('shows unread activity for inactive sessions updated since last seen', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', active: false, updatedAt: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('prefers unread over background for inactive sessions', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'a',
                active: false,
                backgroundTaskCount: 2,
                updatedAt: 5000
            }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })
})

describe('sessionIsUnread', () => {
    it('is true when updatedAt is newer than lastSeenAt', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'u', updatedAt: 5000 }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })

    it('is false when the operator has already seen this update', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'seen', updatedAt: 1000 }),
            { lastSeenAt: 5000 }
        )).toBe(false)
    })

    it('does not care about permission / background fields — only the watermark', () => {
        expect(sessionIsUnread(
            makeSummary({
                id: 'p',
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                updatedAt: 1000,
            }),
            { lastSeenAt: 1000 }
        )).toBe(false)

        expect(sessionIsUnread(
            makeSummary({
                id: 'bg',
                backgroundTaskCount: 3,
                updatedAt: 9000,
            }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })
})
