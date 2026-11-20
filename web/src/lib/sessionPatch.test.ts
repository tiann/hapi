import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { reconcileDelayedListSession } from './sessionPatch'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('reconcileDelayedListSession', () => {
    it('keeps an overflow request visible when a delayed list response predates the dismissal that surfaced it (cold-review round 25)', () => {
        // A list GET captured BEFORE a dismissal (plain oldest-first
        // truncation, so the 201st request is missing from its refs) lands
        // AFTER SSE applied that dismissal and correctly recomputed refs
        // with the 201st included. `agentStateVersion` alone cannot see
        // this — the underlying requests never changed, only which of them
        // are dismissed — so the delayed response's STALE refs must not
        // overwrite the cache's already-correct ones.
        const refs = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, kind: 'permission' as const, since: i }))
        const refsWithOverflow = [...refs, { id: 'r200', kind: 'input' as const, since: 300 }]

        const prior = makeSummary({
            id: 'session-1',
            agentStateVersion: 5,
            notifyUpdatedAt: 10,
            pendingRequestRefs: refsWithOverflow
        })
        // Delayed: same agentStateVersion (nothing about the underlying
        // requests changed), but its OWN refs were computed before the
        // dismissal — plain oldest-first, so r200 fell off.
        const delayed = makeSummary({
            id: 'session-1',
            agentStateVersion: 5,
            notifyUpdatedAt: 8,
            pendingRequestRefs: refs
        })

        const result = reconcileDelayedListSession(prior, delayed)
        expect(result.pendingRequestRefs?.map((r) => r.id)).toContain('r200')
    })

    it('still takes the incoming refs when both signals agree the delayed response is NOT stale', () => {
        const prior = makeSummary({ id: 'session-1', agentStateVersion: 5, notifyUpdatedAt: 10 })
        const incoming = makeSummary({
            id: 'session-1',
            agentStateVersion: 6,
            notifyUpdatedAt: 11,
            pendingRequestRefs: [{ id: 'r0', kind: 'permission', since: 0 }]
        })
        const result = reconcileDelayedListSession(prior, incoming)
        expect(result.pendingRequestRefs).toEqual(incoming.pendingRequestRefs)
    })

    it('keeps prior refs when agentStateVersion alone says the incoming response is stale (existing behaviour)', () => {
        const prior = makeSummary({
            id: 'session-1',
            agentStateVersion: 5,
            notifyUpdatedAt: 10,
            pendingRequestRefs: [{ id: 'r-newer', kind: 'permission', since: 1 }]
        })
        const stale = makeSummary({
            id: 'session-1',
            agentStateVersion: 3,
            notifyUpdatedAt: 10,
            pendingRequestRefs: [{ id: 'r-older', kind: 'permission', since: 0 }]
        })
        const result = reconcileDelayedListSession(prior, stale)
        expect(result.pendingRequestRefs).toEqual(prior.pendingRequestRefs)
        expect(result.agentStateVersion).toBe(5)
    })

    it('does not resurrect an answered prompt: a newer agentStateVersion still wins even with an older notify revision', () => {
        // The agentState-derived bundle (count/kinds/pendingRequests/
        // agentStateVersion) must track `agentStateVersion` specifically,
        // not get pulled back to a stale value just because the notify
        // revision also happens to be stale — only `pendingRequestRefs`
        // depends on the dismissal set.
        const prior = makeSummary({
            id: 'session-1',
            agentStateVersion: 5,
            notifyUpdatedAt: 20,
            pendingRequestsCount: 1
        })
        const incoming = makeSummary({
            id: 'session-1',
            agentStateVersion: 6,
            notifyUpdatedAt: 10,
            pendingRequestsCount: 0
        })
        const result = reconcileDelayedListSession(prior, incoming)
        expect(result.agentStateVersion).toBe(6)
        expect(result.pendingRequestsCount).toBe(0)
    })

    it('keeps a newer thinking=false when a delayed list response still shows thinking=true (cold-review round 26)', () => {
        // If GET /sessions captures a blocked footer while the agent is
        // still thinking, the turn can end and deliver thinking=false over
        // SSE before the GET returns. Neither `thinking` nor
        // `thinkingConfirmed` carries its own revision otherwise, so this
        // merge restored the older thinking=true — and the attention
        // classifier treats "still thinking" as "nothing to show yet",
        // hiding the unanswered footer behind it.
        const prior = makeSummary({ id: 'session-1', thinking: false, thinkingConfirmed: true, thinkingAt: 20 })
        const delayed = makeSummary({ id: 'session-1', thinking: true, thinkingConfirmed: false, thinkingAt: 10 })

        const result = reconcileDelayedListSession(prior, delayed)
        expect(result.thinking).toBe(false)
        expect(result.thinkingConfirmed).toBe(true)
        expect(result.thinkingAt).toBe(20)
    })

    it('still takes the incoming thinking state when it is genuinely newer', () => {
        const prior = makeSummary({ id: 'session-1', thinking: true, thinkingAt: 5 })
        const incoming = makeSummary({ id: 'session-1', thinking: false, thinkingAt: 10 })

        const result = reconcileDelayedListSession(prior, incoming)
        expect(result.thinking).toBe(false)
        expect(result.thinkingAt).toBe(10)
    })
})
