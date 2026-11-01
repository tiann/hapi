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
        updatedAt: 999_999,
        contentRevision: 1000,
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
    it('keeps permission attention on the selected session', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', pendingRequestKinds: ['permission'] }),
            { selected: true, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('shows an explicitly marked unread dot for the selected session', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 5000 }),
            { selected: true, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('keeps an explicitly marked unread dot while the selected session is thinking', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', thinking: true, contentRevision: 5000 }),
            { selected: true, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('keeps unread content while the selected session is reading history', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 5000 }),
            { selected: true, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('carries an explicit unread dot across newer activity', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 6000 }),
            { selected: true, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('prioritizes permission over unread activity', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'a',
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                contentRevision: 5000
            }),
            { selected: false, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('ignores pending requests left on an archived session', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'a',
                active: false,
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                contentRevision: 5000
            }),
            { selected: false, lastSeenAt: 5000 }
        )
        expect(attention).toBeNull()
    })

    it('handles summaries from older APIs without pendingRequestKinds', () => {
        const legacySummary = makeSummary({ id: 'legacy', contentRevision: 5000 }) as unknown as SessionSummary
        delete (legacySummary as Partial<SessionSummary>).pendingRequestKinds

        const attention = classifySessionAttention(
            legacySummary,
            { selected: false, lastSeenAt: 1000 }
        )

        expect(attention).toEqual({ kind: 'unread' })
    })

    it('shows unread activity when the session has updated since last seen', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('does not show ordinary unread activity while the session is thinking', () => {
        expect(classifySessionAttention(
            makeSummary({ id: 'generating', thinking: true, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )).toBeNull()
    })

    it('keeps an explicitly marked unread dot while a session is thinking', () => {
        expect(classifySessionAttention(
            makeSummary({ id: 'manual-thinking', thinking: true, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )).toEqual({ kind: 'unread' })
    })

    it('treats inactive stale thinking as unread activity', () => {
        expect(classifySessionAttention(
            makeSummary({ id: 'expired-thinking', active: false, thinking: true, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )).toEqual({ kind: 'unread' })
    })

    it('shows background work without treating it as unread', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', backgroundTaskCount: 2, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'background' })
    })

    it('shows unread activity for inactive sessions updated since last seen', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', active: false, contentRevision: 5000 }),
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
                contentRevision: 5000
            }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })
})

describe('sessionIsUnread', () => {
    it('is true when contentRevision is newer than the read revision', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'u', contentRevision: 5000 }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })

    it('is false when the operator has already seen this update', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'seen', contentRevision: 1000 }),
            { lastSeenAt: 5000 }
        )).toBe(false)
    })

    it('is false for activity received while the session is thinking', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'generating', thinking: true, contentRevision: 5000 }),
            { lastSeenAt: 1000 }
        )).toBe(false)
    })

    it('allows unread activity from an inactive session with a stale thinking flag', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'expired-thinking', active: false, thinking: true, contentRevision: 5000 }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })

    it('does not care about permission / background fields — only the watermark', () => {
        expect(sessionIsUnread(
            makeSummary({
                id: 'p',
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                contentRevision: 1000,
            }),
            { lastSeenAt: 1000 }
        )).toBe(false)

        expect(sessionIsUnread(
            makeSummary({
                id: 'bg',
                backgroundTaskCount: 3,
                contentRevision: 9000,
            }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })
})
