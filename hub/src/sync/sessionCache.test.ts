import { describe, expect, it } from 'bun:test'

import { mergeForkedAgentState } from './sessionCache'

describe('mergeForkedAgentState', () => {
    it('cancels the old session leftover pending requests instead of carrying them forward', () => {
        const oldState = {
            controlledByUser: false,
            requests: { toolu_orphan: { tool: 'AskUserQuestion', arguments: { q: 1 }, createdAt: 1 } },
            completedRequests: { toolu_done: { tool: 'AskUserQuestion', status: 'approved' } }
        }
        const newState = { controlledByUser: false, requests: {}, completedRequests: {} }

        const merged = mergeForkedAgentState(oldState, newState) as {
            requests: Record<string, unknown>
            completedRequests: Record<string, { tool?: string; status?: string }>
        }

        // Orphan must not remain pending (this is what stranded the "待处理" badge forever).
        expect(merged.requests.toolu_orphan).toBeUndefined()
        // Orphan recorded as canceled so there is an audit trail.
        expect(merged.completedRequests.toolu_orphan.status).toBe('canceled')
        expect(merged.completedRequests.toolu_orphan.tool).toBe('AskUserQuestion')
        // Prior completed entry preserved.
        expect(merged.completedRequests.toolu_done.status).toBe('approved')
    })

    it('keeps the new session own pending requests live', () => {
        const oldState = { requests: { old1: { tool: 'X' } }, completedRequests: {} }
        const newState = { requests: { new1: { tool: 'Y', arguments: {}, createdAt: 2 } }, completedRequests: {} }

        const merged = mergeForkedAgentState(oldState, newState) as {
            requests: Record<string, unknown>
            completedRequests: Record<string, { status?: string }>
        }

        expect(merged.requests.new1).toBeDefined()
        expect(merged.requests.old1).toBeUndefined()
        expect(merged.completedRequests.old1.status).toBe('canceled')
    })

    it('does not resurrect or relabel a request already completed', () => {
        const oldState = { requests: { r: { tool: 'X' } }, completedRequests: { r: { tool: 'X', status: 'denied' } } }
        const newState = { requests: {}, completedRequests: {} }

        const merged = mergeForkedAgentState(oldState, newState) as {
            requests: Record<string, unknown>
            completedRequests: Record<string, { status?: string }>
        }

        expect(merged.requests.r).toBeUndefined()
        expect(merged.completedRequests.r.status).toBe('denied')
    })

    it('keeps a colliding new-session pending instead of canceling it on the shared id', () => {
        const oldState = { requests: { shared: { tool: 'X', arguments: {} } }, completedRequests: {} }
        const newState = { requests: { shared: { tool: 'Y', arguments: { live: true } } }, completedRequests: {} }

        const merged = mergeForkedAgentState(oldState, newState) as {
            requests: Record<string, { tool?: string }>
            completedRequests: Record<string, unknown>
        }

        // The new session's live pending for `shared` wins; it must not be canceled/dropped.
        expect(merged.requests.shared).toBeDefined()
        expect(merged.requests.shared.tool).toBe('Y')
        expect(merged.completedRequests.shared).toBeUndefined()
    })

    it('returns the other side untouched when one is null', () => {
        const s = { requests: {}, completedRequests: {} }
        expect(mergeForkedAgentState(null, s)).toBe(s)
        expect(mergeForkedAgentState(s, null)).toBe(s)
    })
})
