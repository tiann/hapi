import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from './useSessions'

afterEach(cleanup)

function row(id: string, at: number): SessionSummary {
    return {
        id, createdAt: 1, lastUserMessageAt: at, updatedAt: at,
        active: false, thinking: false, activeAt: 0, metadata: null,
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0,
        todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [],
        backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null,
        attachedJob: null, attachedJobUpdatedAt: 0,
        model: null, effort: null
    }
}

it('does not let a delayed REST snapshot undo newer user input from SSE', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const initial = { sessions: [row('b', 200), row('a', 100), row('removed', 50)] }
    client.setQueryData(queryKeys.sessions, initial)
    let resolve!: (response: SessionsResponse) => void
    const getSessions = vi.fn(() => new Promise<SessionsResponse>(done => { resolve = done }))
    const api = { getSessions } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        const pending = result.current.refetch()
        client.setQueryData(queryKeys.sessions, { sessions: [row('a', 300), row('b', 200), row('removed', 50)] })
        resolve({ sessions: [row('b', 200), row('a', 100)] })
        await pending
    })
    const data = client.getQueryData<SessionsResponse>(queryKeys.sessions)!
    expect(data.sessions.map(s => s.id)).toEqual(['a', 'b'])
    expect(data.sessions[0]!.lastUserMessageAt).toBe(300)
})

it('discards a cached thinkingRevision across a detected hub restart, even a small positive one (#1717 cold-review round 29)', async () => {
    // `reconcileDelayedListSession`'s zero-exception alone only covers the
    // instant nothing has ticked yet post-restart; a session whose counter
    // already advanced before this tab's first post-restart GET lands
    // needs `hubGeneration` itself to recognize the restart and discard
    // the stale cached revision regardless of its number. Carried on each
    // session row (matching the real wire shape — the hub's `toSessionSummary`
    // stamps it per-row, not only on the response envelope).
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const getSessions = vi.fn()
    const api = { getSessions } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })

    getSessions.mockResolvedValueOnce({
        sessions: [{ ...row('a', 100), thinking: true, thinkingConfirmed: true, thinkingRevision: 47, hubGeneration: 'process-a' }]
    })
    await act(async () => { await result.current.refetch() })

    getSessions.mockResolvedValueOnce({
        sessions: [{ ...row('a', 100), thinking: false, thinkingConfirmed: true, thinkingRevision: 2, hubGeneration: 'process-b' }]
    })
    await act(async () => { await result.current.refetch() })

    const data = client.getQueryData<SessionsResponse>(queryKeys.sessions)!
    expect(data.sessions[0]!.thinking).toBe(false)
    expect(data.sessions[0]!.thinkingRevision).toBe(2)
})

it('detects a hub restart even across an unmount/remount of the hook, not just within one hook instance (#1717 cold-review round 31)', async () => {
    // A connection-level "last generation seen" ref lives as long as the
    // HOOK INSTANCE does. The QueryClient cache it is meant to protect
    // lives as long as the QueryClient does, which outlives an
    // unmount/remount (navigating away and back, or a tree remount). A
    // fresh hook instance's ref starts at `undefined` regardless of what
    // the still-cached row actually holds, so the FIRST post-remount
    // response was always treated as "no restart" even when the cache it
    // is about to compare against is genuinely stale from a prior process.
    // Reading the generation off the cached ROW itself (not a ref) cannot
    // desync this way, because the row has the SAME lifetime as the data
    // it is protecting.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const getSessionsA = vi.fn().mockResolvedValue({
        sessions: [{ ...row('a', 100), thinking: true, thinkingConfirmed: true, thinkingRevision: 47, hubGeneration: 'process-a' }]
    })
    const apiA = { getSessions: getSessionsA } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)

    const first = renderHook(() => useSessions(apiA, { enabled: false }), { wrapper })
    await act(async () => { await first.result.current.refetch() })
    first.unmount()

    const getSessionsB = vi.fn().mockResolvedValue({
        sessions: [{ ...row('a', 100), thinking: false, thinkingConfirmed: true, thinkingRevision: 2, hubGeneration: 'process-b' }]
    })
    const apiB = { getSessions: getSessionsB } as unknown as ApiClient
    const second = renderHook(() => useSessions(apiB, { enabled: false }), { wrapper })
    await act(async () => { await second.result.current.refetch() })

    const data = client.getQueryData<SessionsResponse>(queryKeys.sessions)!
    expect(data.sessions[0]!.thinking).toBe(false)
    expect(data.sessions[0]!.thinkingRevision).toBe(2)
})
