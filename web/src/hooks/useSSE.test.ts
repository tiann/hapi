import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import type { Session } from '@/types/api'
import { isGlobalScopedMessageStreamEvent, isRenderIrrelevantPatch, isRenderIrrelevantSessionPatch } from './useSSE'

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
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
        ...overrides
    } as SessionSummary
}

describe('useSSE scope handling', () => {
    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})

describe('isRenderIrrelevantPatch', () => {
    it('treats a keep-alive that only moves activeAt as irrelevant', () => {
        const current = makeSummary({ activeAt: 1_000 })
        const next = makeSummary({ activeAt: 11_000 })

        expect(isRenderIrrelevantPatch(current, next)).toBe(true)
    })

    it('treats an identical summary as irrelevant', () => {
        expect(isRenderIrrelevantPatch(makeSummary(), makeSummary())).toBe(true)
    })

    it.each([
        ['active', { active: false }],
        ['thinking', { thinking: true }],
        ['updatedAt', { updatedAt: 9_999 }],
        ['backgroundTaskCount', { backgroundTaskCount: 3 }],
        ['model', { model: 'opus' }],
        ['modelReasoningEffort', { modelReasoningEffort: 'high' }],
        ['effort', { effort: 'medium' }],
        ['pendingRequestsCount', { pendingRequestsCount: 2 }]
    ] as Array<[string, Partial<SessionSummary>]>)('reports %s changes as relevant', (_field, change) => {
        const current = makeSummary()
        const next = makeSummary({ ...change, activeAt: 11_000 })

        expect(isRenderIrrelevantPatch(current, next)).toBe(false)
    })
})

describe('isRenderIrrelevantSessionPatch', () => {
    const session = {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        model: 'opus',
        effort: null,
        permissionMode: 'default',
        serviceTier: null
    } as unknown as Session

    it('treats a keep-alive that only moves activeAt as irrelevant', () => {
        expect(isRenderIrrelevantSessionPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            model: 'opus',
            effort: null,
            permissionMode: 'default',
            serviceTier: null
        })).toBe(true)
    })

    it('reports a changed field as relevant even alongside a new activeAt', () => {
        expect(isRenderIrrelevantSessionPatch(session, {
            thinking: true,
            activeAt: 11_000
        })).toBe(false)
    })

    it('reports a field the session does not carry yet as relevant', () => {
        // scratchlistUpdatedAt is absent from the cached session, so the patch
        // genuinely adds information and must not be dropped.
        expect(isRenderIrrelevantSessionPatch(session, {
            activeAt: 11_000,
            scratchlistUpdatedAt: 5_000
        })).toBe(false)
    })

    it('treats an empty patch as irrelevant', () => {
        expect(isRenderIrrelevantSessionPatch(session, {})).toBe(true)
    })
})
