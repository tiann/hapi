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

    it('keeps pendingRequestRefs in sync with the newer agentState rather than pinned to a stale notify revision (#1717)', () => {
        // The sibling test above asserts the aggregate fields track the
        // newer `agentStateVersion` but never checked `pendingRequestRefs`
        // itself — which is exactly where this broke: `keepPriorRefs` OR'd
        // the two staleness signals together, so an older notify revision
        // alone kept PRIOR's refs (describing an already-answered request)
        // even though `agentStateVersion` said the request set had moved
        // on. The classifier reads `pendingRequestRefs` FIRST when present,
        // so the chip described and offered to dismiss the wrong, already-
        // resolved request.
        const prior = makeSummary({
            id: 'session-1',
            agentStateVersion: 5,
            notifyUpdatedAt: 20,
            pendingRequestRefs: [{ id: 'answered-request', kind: 'permission', since: 1 }]
        })
        const incoming = makeSummary({
            id: 'session-1',
            agentStateVersion: 6,
            notifyUpdatedAt: 10,
            pendingRequestRefs: [{ id: 'new-request', kind: 'permission', since: 2 }]
        })
        const result = reconcileDelayedListSession(prior, incoming)
        expect(result.pendingRequestRefs).toEqual(incoming.pendingRequestRefs)
    })

    it('keeps a newer thinking=false when a delayed list response still shows thinking=true (cold-review round 26)', () => {
        // If GET /sessions captures a blocked footer while the agent is
        // still thinking, the turn can end and deliver thinking=false over
        // SSE before the GET returns. Neither `thinking` nor
        // `thinkingConfirmed` carries its own revision otherwise, so this
        // merge restored the older thinking=true — and the attention
        // classifier treats "still thinking" as "nothing to show yet",
        // hiding the unanswered footer behind it.
        const prior = makeSummary({ id: 'session-1', thinking: false, thinkingConfirmed: true, thinkingRevision: 2 })
        const delayed = makeSummary({ id: 'session-1', thinking: true, thinkingConfirmed: false, thinkingRevision: 1 })

        const result = reconcileDelayedListSession(prior, delayed)
        expect(result.thinking).toBe(false)
        expect(result.thinkingConfirmed).toBe(true)
        expect(result.thinkingRevision).toBe(2)
    })

    it('trusts a reported thinkingRevision of 0 even when the cached one is higher (#1717)', () => {
        // `thinkingRevision` lives only in the hub's in-memory cache — a
        // restart resets every session's counter to 0, but this tab's
        // cached summary keeps whatever higher value it saw from the
        // previous process. A reported 0 must win outright, or the
        // restarted hub's genuinely current `thinking: false` (and the
        // blocker it would otherwise reveal) stays hidden behind a stale
        // cached `thinking: true` forever.
        const prior = makeSummary({ id: 'session-1', thinking: true, thinkingConfirmed: true, thinkingRevision: 47 })
        const postRestart = makeSummary({ id: 'session-1', thinking: false, thinkingConfirmed: true, thinkingRevision: 0 })

        const result = reconcileDelayedListSession(prior, postRestart)
        expect(result.thinking).toBe(false)
        expect(result.thinkingRevision).toBe(0)
    })

    it('trusts a reported thinkingRevision after a hub restart even when it is a small POSITIVE number (#1717 cold-review round 29)', () => {
        // The zero-exception above only covers the instant nothing has
        // ticked yet. If some OTHER session's activity bumps the restarted
        // hub's counter before this tab's first post-restart list GET
        // lands, the reported revision is a small positive number that
        // still loses to this tab's much higher pre-restart cached value —
        // unless `hubGeneration` itself tells this function a restart
        // happened at all, regardless of what the number reads.
        const prior = makeSummary({ id: 'session-1', thinking: true, thinkingConfirmed: true, thinkingRevision: 47, hubGeneration: 'process-a' })
        const postRestart = makeSummary({ id: 'session-1', thinking: false, thinkingConfirmed: true, thinkingRevision: 2, hubGeneration: 'process-b' })

        const result = reconcileDelayedListSession(prior, postRestart)
        expect(result.thinking).toBe(false)
        expect(result.thinkingRevision).toBe(2)
    })

    it('still takes the incoming thinking state when it is genuinely newer', () => {
        const prior = makeSummary({ id: 'session-1', thinking: true, thinkingRevision: 1 })
        const incoming = makeSummary({ id: 'session-1', thinking: false, thinkingRevision: 2 })

        const result = reconcileDelayedListSession(prior, incoming)
        expect(result.thinking).toBe(false)
        expect(result.thinkingRevision).toBe(2)
    })

    it('does not get fooled by an identical thinkingAt across two distinct transitions (cold-review round 27)', () => {
        // `thinkingAt` is the CLI's own clamped alive-report time: two
        // transitions processed within the same clamped-to-"now"
        // millisecond can carry the IDENTICAL value, which a strict `>`
        // check on it cannot tell apart. `thinkingRevision` is a counter,
        // not a clock — it still orders them correctly even when
        // `thinkingAt` cannot.
        const prior = makeSummary({
            id: 'session-1', thinking: false, thinkingAt: 1_000, thinkingRevision: 4
        })
        const delayed = makeSummary({
            id: 'session-1', thinking: true, thinkingAt: 1_000, thinkingRevision: 3
        })

        const result = reconcileDelayedListSession(prior, delayed)
        expect(result.thinking).toBe(false)
    })
})
