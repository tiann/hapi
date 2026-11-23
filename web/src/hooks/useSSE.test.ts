import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import type { Session } from '@/types/api'
import { readSessionWithLiveUpdates } from '@/lib/sessionDetailRead'
import { queryKeys } from '@/lib/query-keys'
import { reconcileDelayedListSession } from '@/lib/sessionPatch'
import {
    applySessionDetailPatch,
    isGlobalScopedMessageStreamEvent,
    isNewerVersionedPatch,
    isRenderIrrelevantPatch,
    isRenderIrrelevantSessionPatch,
    sameSessionSummaryMetadata,
    shouldInvalidateSessionListForEvent,
    useSSE
} from './useSSE'

describe('session summary metadata equality', () => {
    it('detects capability changes that control list actions', () => {
        const base = { path: '/p', host: 'h' }
        expect(sameSessionSummaryMetadata(base, { ...base, conversationHistory: { forkCurrent: true } })).toBe(false)
        expect(sameSessionSummaryMetadata(
            { ...base, conversationHistory: { forkCurrent: true } },
            { ...base, conversationHistory: { forkCurrent: true } },
        )).toBe(true)
    })
})

class FakeEventSource {
    static instances: FakeEventSource[] = []
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readonly url: string
    readyState = FakeEventSource.CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((error: unknown) => void) | null = null

    constructor(url: string) {
        this.url = url
        FakeEventSource.instances.push(this)
    }

    close(): void {
        this.readyState = FakeEventSource.CLOSED
    }

    simulateOpen(): void {
        this.readyState = FakeEventSource.OPEN
        this.onopen?.()
    }

    simulateMessage(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
    }
}

function renderUseSSE(options?: {
    onDisconnect?: (reason: string) => void
}) {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
    const hook = renderHook(() => useSSE({
        enabled: true,
        token: 'test-token',
        baseUrl: 'http://hub.test',
        subscription: { all: true },
        onEvent: () => {},
        onDisconnect: options?.onDisconnect
    }), { wrapper })
    return { ...hook, queryClient }
}

describe('useSSE connection liveness (mobile suspend/resume)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it('reconnects on visibility resume when a heartbeat interval was missed', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        expect(FakeEventSource.instances).toHaveLength(1)
        act(() => { FakeEventSource.instances[0]?.simulateOpen() })

        // Silence for 70s: more than one 30s heartbeat missed, but below the
        // 90s watchdog threshold. A resume from background must not trust
        // this connection.
        act(() => { vi.advanceTimersByTime(70_000) })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })

        expect(onDisconnect).toHaveBeenCalledWith('visibility-recovery')
        expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED)

        // First reconnect attempt is immediate (jitter only)
        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        unmount()
    })

    it('keeps a fresh connection on visibility resume', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        act(() => { vi.advanceTimersByTime(20_000) })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })

        expect(onDisconnect).not.toHaveBeenCalled()
        expect(FakeEventSource.instances).toHaveLength(1)

        unmount()
    })

    it('abandons a connection attempt that does not open in time', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        expect(FakeEventSource.instances).toHaveLength(1)
        // never opens (e.g. request hung on a dead pooled socket)
        act(() => { vi.advanceTimersByTime(10_100) })

        expect(onDisconnect).toHaveBeenCalledWith('connect-timeout')
        expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED)

        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        unmount()
    })

    it('does not time out a connection that opens promptly', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        act(() => { vi.advanceTimersByTime(30_000) })

        expect(onDisconnect).not.toHaveBeenCalled()
        expect(FakeEventSource.instances).toHaveLength(1)

        unmount()
    })

    it('abandons a hung reconnect attempt even after a prior reconnect request', () => {
        const onDisconnect = vi.fn()
        const { unmount } = renderUseSSE({ onDisconnect })

        act(() => { FakeEventSource.instances[0]?.simulateOpen() })
        // First cycle: transport error while the source is up routes through
        // requestReconnect, which is one-shot per EventSource instance.
        act(() => { FakeEventSource.instances[0]?.onerror?.({}) })
        expect(onDisconnect).toHaveBeenCalledWith('transport-error')

        act(() => { vi.advanceTimersByTime(600) })
        expect(FakeEventSource.instances).toHaveLength(2)

        // Second cycle never opens — the connect deadline must still fire
        // (force path) instead of being swallowed by the one-shot guard.
        act(() => { vi.advanceTimersByTime(10_100) })
        expect(onDisconnect).toHaveBeenCalledWith('connect-timeout')
        expect(FakeEventSource.instances[1]?.readyState).toBe(FakeEventSource.CLOSED)

        unmount()
    })
})

describe('useSSE scratchlist status invalidation', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    it('invalidates both the session scratchlist and batch status queries', () => {
        const { unmount, queryClient } = renderUseSSE()
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)

        act(() => {
            FakeEventSource.instances[0]?.simulateMessage({
                type: 'session-updated',
                sessionId: 'session-1',
                data: { scratchlistUpdatedAt: 1234 }
            })
            vi.advanceTimersByTime(20)
        })

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.scratchlist('session-1') })
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.scratchlistSessionIds })
        unmount()
    })
})

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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    } as SessionSummary
}

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

    it('reports a thinkingRevision-only move as relevant even when thinking itself is unchanged (#1717)', () => {
        // A revision bump with no visible change still has to persist into
        // the cache: skipping it here leaves the cache holding a STALE
        // revision, which lets a later, out-of-order patch (dated between
        // the two) win a comparison it should have lost and drag `thinking`
        // back to a stale value.
        const current = makeSummary({ thinking: false, thinkingRevision: 10 })
        const next = makeSummary({ thinking: false, thinkingRevision: 12, activeAt: 11_000 })

        expect(isRenderIrrelevantPatch(current, next)).toBe(false)
    })

    it('reports attachedJob.startedAt changes as relevant', () => {
        const job = {
            key: 'beets',
            label: 'beets',
            status: 'running' as const,
            heartbeatAt: 100,
            startedAt: 100,
            updatedAt: 100
        }
        const current = makeSummary({ attachedJob: job })
        const next = makeSummary({
            attachedJob: { ...job, startedAt: 50 },
            activeAt: 11_000
        })
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

    it('ignores a stale thinking patch that arrived after a fresher one on the other SSE stream (cold-review round 27)', () => {
        // Incremental patches ride the same two unordered streams a full
        // session snapshot does, so without an ordering value a stale
        // `thinking` patch could still overwrite a fresher one.
        const thinkingSession = { ...session, thinking: false, thinkingRevision: 2 } as unknown as Session
        expect(applySessionDetailPatch(thinkingSession, {
            thinking: true,
            thinkingRevision: 1
        })).toBeNull()
    })

    it('still applies a genuinely newer thinking patch', () => {
        const thinkingSession = { ...session, thinking: false, thinkingRevision: 2 } as unknown as Session
        const next = applySessionDetailPatch(thinkingSession, {
            thinking: true,
            thinkingRevision: 3
        })
        expect(next?.thinking).toBe(true)
        expect(next?.thinkingRevision).toBe(3)
    })

    it('does not get fooled by an identical thinkingAt across two distinct transitions', () => {
        // `thinkingAt` is the CLI's clamped alive-report time, not a
        // hub-issued revision — two transitions can carry the identical
        // value. `thinkingRevision` orders them correctly regardless.
        const thinkingSession = { ...session, thinking: false, thinkingAt: 1_000, thinkingRevision: 4 } as unknown as Session
        expect(applySessionDetailPatch(thinkingSession, {
            thinking: true,
            thinkingAt: 1_000,
            thinkingRevision: 3
        })).toBeNull()
    })

    it('applies a reported thinkingRevision of 0 even when the cached one is higher (#1717)', () => {
        // `thinkingRevision` lives only in the hub's in-memory cache — a
        // restart resets every session's counter to 0, but this cached
        // Session keeps whatever higher value it saw from the previous
        // process. A reported 0 must win outright, or a genuinely current
        // post-restart `thinking: false` stays hidden behind the stale one.
        const thinkingSession = { ...session, thinking: true, thinkingRevision: 47 } as unknown as Session
        const next = applySessionDetailPatch(thinkingSession, {
            thinking: false,
            thinkingRevision: 0
        })
        expect(next?.thinking).toBe(false)
        expect(next?.thinkingRevision).toBe(0)
    })
})

describe('useSSE user-activity ordering', () => {
    beforeEach(() => {
        FakeEventSource.instances = []
        vi.stubGlobal('EventSource', FakeEventSource)
    })
    afterEach(() => vi.unstubAllGlobals())

    it('ignores agent/status updates, promotes new input, and rejects stale replay', () => {
        const { queryClient, unmount } = renderUseSSE()
        const sessions = [
            makeSummary({ id: 'new', createdAt: 3_000, lastUserMessageAt: 8_000 }),
            makeSummary({ id: 'old', createdAt: 1_000, lastUserMessageAt: 5_000 })
        ]
        queryClient.setQueryData(queryKeys.sessions, { sessions })
        const patch = (sessionId: string, data: Record<string, unknown>) => act(() => {
            FakeEventSource.instances[0]?.simulateMessage({ type: 'session-updated', sessionId, data })
        })
        const read = () => queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)!.sessions
        for (let i = 0; i < 10; i++) {
            patch('old', { updatedAt: 90_000 + i, thinking: true, active: true })
            patch('new', { updatedAt: 100_000 + i, thinking: false, active: false })
            expect(read().map(s => s.id)).toEqual(['new', 'old'])
        }
        patch('old', { lastUserMessageAt: 200_000 })
        expect(read().map(s => s.id)).toEqual(['old', 'new'])
        patch('old', { lastUserMessageAt: 4_000 })
        expect(read()[0]!.lastUserMessageAt).toBe(200_000)
        expect(read().map(s => s.id)).toEqual(['old', 'new'])
        unmount()
    })

    it('observes an expiry even without a detail row to patch during a cold fetch', async () => {
        const { queryClient, unmount } = renderUseSSE()
        let resolve!: (value: { session: Session }) => void
        const stopped = { active: false, activeAt: 10, thinking: false, activeTurnStartedAt: null } as Session
        const fetch = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ session: stopped })
        const read = readSessionWithLiveUpdates(queryClient, 'cold', fetch)
        act(() => FakeEventSource.instances[0]?.simulateMessage({ type: 'session-updated', sessionId: 'cold',
            data: { active: false, activeAt: 10, thinking: false, activeTurnStartedAt: null } }))
        resolve({ session: { active: true, activeAt: 10, thinking: true, activeTurnStartedAt: 5 } as Session })
        expect((await read).session).toMatchObject({ active: false, activeAt: 10, thinking: false, activeTurnStartedAt: null })
        unmount()
    })

    it('preserves the user timestamp through a stale full-session event', () => {
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({ id: 'session-1', lastUserMessageAt: 9_000 })] })
        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary(), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, agentState: null, thinkingAt: 0, lastUserMessageAt: 1_000
            }
        }))
        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.lastUserMessageAt).toBe(9_000)
        unmount()
    })

    it('keeps an overflow request visible through an SSE agentState patch, after its oldest 200 siblings are dismissed (cold-review round 24)', () => {
        // The REST projection already passes dismissal keys into
        // computePendingRequestRefs, prioritizing an undismissed request
        // over a dismissed one past the 200-ref cap. This incremental SSE
        // patch path recomputed the same field without them, so it reverted
        // to plain oldest-first truncation — a 201st request arriving by
        // patch, genuinely unanswered, dropped off the capped list the web
        // actually reads until the next full refresh.
        const { queryClient, unmount } = renderUseSSE()
        // Explicit, strictly-ascending `createdAt` so oldest-first truncation
        // has an unambiguous newest-of-201 to drop — ids alone sort
        // lexicographically ('r200' < 'r3'), which would mask the bug.
        const requests: Record<string, { tool: string; arguments: Record<string, never>; createdAt: number }> = {}
        for (let i = 0; i < 200; i++) requests[`r${i}`] = { tool: 'Bash', arguments: {}, createdAt: i }
        const dismissedKeys = Array.from({ length: 200 }, (_, i) => `request:r${i}`)
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1',
            pendingRequestsCount: 200,
            agentStateVersion: 1,
            blockedAck: { at: Date.now(), reason: 'handled', keys: dismissedKeys }
        })] })

        // A new, 201st (and NEWEST) request arrives via an incremental
        // agentState patch — not a full-session refresh.
        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: { agentState: { version: 2, value: { requests: { ...requests, r200: { tool: 'Bash', arguments: {}, createdAt: 300 } } } } }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        const refs = data?.sessions[0]?.pendingRequestRefs ?? []
        expect(refs.map((r) => r.id)).toContain('r200')
        unmount()
    })

    it('keeps an overflow request visible through a delayed full-session SSE snapshot (cold-review round 26)', () => {
        // Round 25 fixed this gap in the REST list path
        // (`reconcileDelayedListSession`). The SAME gap exists in THIS path
        // — a full session object can arrive on either the global or the
        // session-scoped SSE stream with no ordering between them, and
        // `pendingRequestRefs` was only re-gated by `agentStateVersion`, not
        // by the notify/dismissal revision a delayed snapshot can also be
        // stale on.
        const { queryClient, unmount } = renderUseSSE()
        const richerRefs = [
            { id: 'r0', kind: 'permission' as const, since: 0 },
            { id: 'r200', kind: 'input' as const, since: 300 }
        ]
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1',
            agentStateVersion: 1,
            notifyUpdatedAt: 10,
            pendingRequestRefs: richerRefs
        })] })

        // A full-session snapshot arrives with the SAME agentStateVersion
        // (the underlying requests never changed) but an OLDER notify
        // revision — captured before the dismissal that surfaced r200 — and
        // its own (stale) refs computed without it.
        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary(), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, agentState: null, thinkingAt: 0,
                agentStateVersion: 1, notifyUpdatedAt: 8,
                pendingRequestRefs: [{ id: 'r0', kind: 'permission', since: 0 }]
            }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        const refs = data?.sessions[0]?.pendingRequestRefs ?? []
        expect(refs.map((r) => r.id)).toContain('r200')
        unmount()
    })

    it('keeps pendingRequestRefs in sync with a newer agentState rather than pinned to a stale notify revision (#1717)', () => {
        // `pendingRequestRefs`' CONTENT describes the same request set
        // `pendingRequestsCount`/`pendingRequestKinds` do, which move on
        // `agentStateVersion` — gating refs on EITHER staleness signal
        // alone (#1717 bot review) kept EXISTING's refs even when
        // incoming's `agentStateVersion` was strictly newer, describing a
        // request the fresher agentState had already replaced.
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1',
            agentStateVersion: 5,
            notifyUpdatedAt: 20,
            pendingRequestRefs: [{ id: 'answered-request', kind: 'permission', since: 1 }]
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary(), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, thinkingAt: 0,
                // `pendingRequestRefs` is never carried on the wire for a
                // full snapshot — `toSessionSummary` always recomputes it
                // from `agentState`, so the fixture has to describe the
                // underlying request, not the derived ref list.
                agentState: { requests: { 'new-request': { tool: 'Bash', arguments: {}, createdAt: 2 } } },
                agentStateVersion: 6, notifyUpdatedAt: 10
            }
        }))

        const data2 = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        const refs2 = data2?.sessions[0]?.pendingRequestRefs ?? []
        expect(refs2.map((r) => r.id)).toEqual(['new-request'])
        unmount()
    })

    it('keeps a newer thinking=false when a delayed full-session SSE snapshot still shows thinking=true (cold-review round 26)', () => {
        // Same gap as `reconcileDelayedListSession`'s Major, in this OTHER
        // path that populates the list: a full-session snapshot can arrive
        // on either SSE stream with no ordering between them, so one stream
        // can deliver a stale `thinking: true` after the other already
        // delivered the idle patch that ended the turn.
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: false, thinkingConfirmed: true, thinkingRevision: 2
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary(), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, agentState: null, thinkingAt: 0,
                thinking: true, thinkingConfirmed: false, thinkingRevision: 1
            }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.thinking).toBe(false)
        expect(data?.sessions[0]?.thinkingRevision).toBe(2)
        unmount()
    })

    it('applies a reported thinkingRevision of 0 in a full-session snapshot even when the cached one is higher (#1717)', () => {
        // `thinkingRevision` lives only in the hub's in-memory cache — a
        // restart resets every session's counter to 0, but this cached row
        // keeps whatever higher value it saw from the previous process. A
        // reported 0 must win outright, or a genuinely current post-restart
        // `thinking: false` stays hidden behind the stale cached one.
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: true, thinkingConfirmed: true, thinkingRevision: 47
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary(), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, agentState: null, thinkingAt: 0,
                thinking: false, thinkingConfirmed: true, thinkingRevision: 0
            }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.thinking).toBe(false)
        expect(data?.sessions[0]?.thinkingRevision).toBe(0)
        unmount()
    })

    it('does not get fooled by an identical thinkingAt across two distinct transitions in a full-session snapshot (cold-review round 27)', () => {
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: false, thinkingAt: 1_000, thinkingRevision: 4
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                ...makeSummary(), id: 'session-1', namespace: 'default', seq: 1,
                createdAt: 1, agentState: null,
                thinking: true, thinkingAt: 1_000, thinkingRevision: 3
            }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.thinking).toBe(false)
        unmount()
    })

    it('ignores a stale thinking patch that arrived after a fresher one on the other SSE stream (cold-review round 27)', () => {
        // The incremental patch path has the SAME exposure as the full
        // snapshot above — it rides the same two unordered streams — but
        // had no mechanism to detect staleness at all until `thinkingRevision`
        // was added to `SessionPatchSchema`.
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: false, thinkingConfirmed: true, thinkingRevision: 2
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: { thinking: true, thinkingConfirmed: false, thinkingRevision: 1 }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.thinking).toBe(false)
        expect(data?.sessions[0]?.thinkingRevision).toBe(2)
        unmount()
    })

    it('applies an incremental patch reporting thinkingRevision 0 even when the cached one is higher (#1717)', () => {
        // Same restart exposure as the full-snapshot path above: a reported
        // 0 must win outright, since it can only mean either a never-bumped
        // session or a hub process that no longer exists to be "fresher"
        // than.
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: true, thinkingConfirmed: true, thinkingRevision: 47
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: { thinking: false, thinkingConfirmed: true, thinkingRevision: 0 }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.thinking).toBe(false)
        expect(data?.sessions[0]?.thinkingRevision).toBe(0)
        unmount()
    })

    it('still takes a genuinely newer thinking patch through the incremental path', () => {
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: false, thinkingRevision: 1
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: { thinking: true, thinkingRevision: 2 }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.thinking).toBe(true)
        expect(data?.sessions[0]?.thinkingRevision).toBe(2)
        unmount()
    })

    it('does not get fooled by an identical thinkingAt across two distinct transitions, through either path (cold-review round 27)', () => {
        // `thinkingAt` is the CLI's own clamped alive-report time: two
        // transitions processed within the same clamped-to-"now"
        // millisecond can carry the IDENTICAL value, which a strict `>`
        // check on it could not tell apart. `thinkingRevision` is a counter
        // issued by the hub, not a clock, so it still orders them correctly.
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: false, thinkingAt: 1_000, thinkingRevision: 4
        })] })

        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: { thinking: true, thinkingAt: 1_000, thinkingRevision: 3 }
        }))

        const data = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(data?.sessions[0]?.thinking).toBe(false)
        unmount()
    })

    it('end to end: a real idle SSE patch then a delayed, pre-idle GET response keep the blocker visible (cold-review round 27)', () => {
        // The bot's own methodological note on the earlier version of this
        // fix: seeding `thinkingAt`/`thinkingRevision` directly on a hand
        // built fixture tests the GUARD, not the SYSTEM — it never proves
        // the hub's real idle-transition patch actually carries a value the
        // guard can use. This test drives the mechanism instead: a real SSE
        // patch, shaped exactly as `handleSessionAlive`'s emit produces it,
        // lands on the cache FIRST; only THEN does a delayed REST response
        // (captured earlier, while still thinking, with the footer that
        // made it blocked) get reconciled against whatever that real patch
        // left behind.
        const { queryClient, unmount } = renderUseSSE()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({
            id: 'session-1', thinking: true, thinkingConfirmed: true,
            thinkingAt: 1_000, thinkingRevision: 1,
            lastNotify: { status: 'blocked', at: 1_000, note: 'stuck' },
            notifyUpdatedAt: 1
        })] })

        // The real idle-transition patch shape (handleSessionAlive's main
        // emit, round 26/27): the turn ends while the browser's delayed GET
        // (below) is still in flight.
        act(() => FakeEventSource.instances[0]?.simulateMessage({
            type: 'session-updated', sessionId: 'session-1',
            data: {
                active: true, activeAt: 5_000, thinking: false, thinkingAt: 5_000,
                thinkingRevision: 2, thinkingConfirmed: true, activeTurnStartedAt: null,
                model: null, modelReasoningEffort: null, effort: null, serviceTier: null
            }
        }))

        const afterIdlePatch = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
            ?.sessions[0]
        expect(afterIdlePatch?.thinking).toBe(false)

        // The delayed GET: captured BEFORE the idle transition, while still
        // thinking, carrying the same blocked footer and the OLDER revision.
        const delayedGet = makeSummary({
            id: 'session-1', thinking: true, thinkingConfirmed: true,
            thinkingAt: 1_000, thinkingRevision: 1,
            lastNotify: { status: 'blocked', at: 1_000, note: 'stuck' },
            notifyUpdatedAt: 1
        })
        const reconciled = reconcileDelayedListSession(afterIdlePatch, delayedGet)

        expect(reconciled.thinking).toBe(false)
        unmount()
    })
})
