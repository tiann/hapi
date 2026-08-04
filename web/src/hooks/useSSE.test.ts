import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import type { Session } from '@/types/api'
import {
    applySessionDetailPatch,
    canApplyVersionedSummaryPatch,
    isGlobalScopedMessageStreamEvent,
    isNewerVersionedPatch,
    isRenderIrrelevantPatch,
    isRenderIrrelevantSessionPatch,
    shouldInvalidateSessionListForEvent
} from './useSSE'

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
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
    } as SessionSummary
}

describe('canApplyVersionedSummaryPatch (PR #897 review, HAPI Bot 2026-07-23 Major)', () => {
    it('allows non-versioned patches without a detail cache', () => {
        expect(canApplyVersionedSummaryPatch({}, false)).toBe(true)
        expect(canApplyVersionedSummaryPatch({ metadata: undefined, agentState: undefined }, false)).toBe(true)
    })

    it('refuses metadata/agentState/todos summary patches when detail version source is missing', () => {
        expect(
            canApplyVersionedSummaryPatch(
                { metadata: { version: 1, value: null } },
                false
            )
        ).toBe(false)
        expect(
            canApplyVersionedSummaryPatch(
                { agentState: { version: 1, value: null } },
                false
            )
        ).toBe(false)
        expect(
            canApplyVersionedSummaryPatch(
                { todos: { version: 1, value: [] } },
                false
            )
        ).toBe(false)
    })

    it('allows teamState-only patches without detail (summary no-op)', () => {
        expect(
            canApplyVersionedSummaryPatch(
                { teamState: { version: 1, value: null } },
                false
            )
        ).toBe(true)
    })

    it('allows versioned summary patches when detail is present', () => {
        expect(
            canApplyVersionedSummaryPatch(
                { metadata: { version: 2, value: null } },
                true
            )
        ).toBe(true)
        expect(
            canApplyVersionedSummaryPatch(
                { todos: { version: 2, value: [] } },
                true
            )
        ).toBe(true)
    })
})

describe('isNewerVersionedPatch (PR #897 review, HAPI Bot 2026-06-16 Major)', () => {
    // Pin the version-monotonicity contract for structured metadata /
    // agentState patches. Without this gate, an SSE reconnect that replays
    // a buffered older patch after a fresh REST refetch would regress the
    // cache (e.g. drop a newer resume id / pending request). Mirrors the
    // hub's CLI room handler check (`incoming.version > currentVersion`).
    it('accepts a strictly newer patch', () => {
        expect(isNewerVersionedPatch(5, 4)).toBe(true)
    })

    it('rejects an older patch (the bug case: stale buffered patch on reconnect)', () => {
        expect(isNewerVersionedPatch(4, 5)).toBe(false)
    })

    it('rejects a same-version patch (idempotent / duplicate replay)', () => {
        expect(isNewerVersionedPatch(5, 5)).toBe(false)
    })

    it('accepts the first write into a freshly-cached session (currentVersion=0)', () => {
        expect(isNewerVersionedPatch(1, 0)).toBe(true)
    })
})

describe('useSSE scope handling', () => {
    it('invalidates the global session list when message ownership changes', () => {
        expect(shouldInvalidateSessionListForEvent('global', 'messages-invalidated')).toBe(true)
        expect(shouldInvalidateSessionListForEvent('full', 'messages-invalidated')).toBe(false)
    })

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
        ['pendingRequestsCount', { pendingRequestsCount: 2 }],
        ['metadata.path', { metadata: { path: '/other', name: undefined } }],
        ['metadata.flavor', { metadata: { path: '/tmp', flavor: 'claude' as const } }],
        ['metadata.machineId', { metadata: { path: '/tmp', machineId: 'Teemo' } }],
        ['metadata.worktree.branch', {
            metadata: {
                path: '/tmp',
                worktree: {
                    basePath: '/tmp',
                    branch: 'feat/x',
                    name: 'x',
                    worktreePath: '/tmp/x'
                }
            }
        }]
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

    it('treats a sub-minute activeAt keep-alive as irrelevant', () => {
        // Relative age stays in the `just now` bucket until 60s; accepting
        // every ~10s heartbeat would thrash the full chat tree for no visible change.
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

    it('treats an activeAt move of at least one minute as render-relevant', () => {
        // Live sessions need the cached stamp to advance so the header does
        // not flip from `just now` to `1m ago` while keep-alives continue.
        expect(isRenderIrrelevantSessionPatch(session, {
            active: true,
            thinking: false,
            activeAt: 1_000 + 60_000,
            model: 'opus',
            effort: null,
            permissionMode: 'default',
            serviceTier: null
        })).toBe(false)
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

describe('applySessionDetailPatch (PR #897 review, Copilot keep-alive)', () => {
    const session = {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        model: 'gpt-5',
        effort: null,
        permissionMode: 'default',
        collaborationMode: undefined,
        copilotAgentMode: 'interactive',
        serviceTier: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        teamStateUpdatedAt: 0
    } as unknown as Session

    it('applies a copilotAgentMode keep-alive change to the detail session', () => {
        // Hub emits copilotAgentMode from markSessionActive keep-alives. The
        // field-by-field mapper must copy it — otherwise detailPatched=true
        // suppresses invalidation and SessionChat keeps the stale mode.
        const next = applySessionDetailPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: 'plan'
        })
        expect(next).not.toBeNull()
        expect(next?.copilotAgentMode).toBe('plan')
        expect(next?.activeAt).toBe(11_000)
    })

    it('returns null for a keep-alive that only repeats the current Copilot mode', () => {
        expect(applySessionDetailPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: 'interactive'
        })).toBeNull()
    })
})
