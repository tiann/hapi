import { describe, expect, it } from 'vitest'
import {
    canApplyVersionedSummaryPatch,
    isGlobalScopedMessageStreamEvent,
    isNewerVersionedPatch
} from './useSSE'

describe('canApplyVersionedSummaryPatch (PR #897 review, HAPI Bot 2026-07-23 Major)', () => {
    it('allows non-versioned patches without a detail cache', () => {
        expect(canApplyVersionedSummaryPatch({}, false)).toBe(true)
        expect(canApplyVersionedSummaryPatch({ metadata: undefined, agentState: undefined }, false)).toBe(true)
    })

    it('refuses metadata/agentState summary patches when detail version source is missing', () => {
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
    })

    it('allows versioned summary patches when detail is present', () => {
        expect(
            canApplyVersionedSummaryPatch(
                { metadata: { version: 2, value: null } },
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
