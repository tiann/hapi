import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { summarizePendingPrompts } from './PendingPromptsBanner'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    const { id, ...rest } = overrides
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/repo' },
        todoProgress: null,
        pendingRequestsCount: 0,
        ...rest
    }
}

describe('summarizePendingPrompts', () => {
    it('totals pending counts and keeps only sessions with pending prompts', () => {
        const summary = summarizePendingPrompts([
            makeSession({ id: 'none', pendingRequestsCount: 0 }),
            makeSession({ id: 'one', pendingRequestsCount: 1, updatedAt: 100 }),
            makeSession({ id: 'two', pendingRequestsCount: 2, updatedAt: 50 })
        ])

        expect(summary.totalPrompts).toBe(3)
        expect(summary.sessionsWithPending.map((session) => session.id)).toEqual(['two', 'one'])
    })

    it('uses updatedAt as tie-breaker for equal pending counts', () => {
        const summary = summarizePendingPrompts([
            makeSession({ id: 'older', pendingRequestsCount: 2, updatedAt: 100 }),
            makeSession({ id: 'newer', pendingRequestsCount: 2, updatedAt: 200 })
        ])

        expect(summary.sessionsWithPending[0]?.id).toBe('newer')
    })
})
