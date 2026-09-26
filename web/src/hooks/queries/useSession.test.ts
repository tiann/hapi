import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session, SessionResponse, SessionSummary, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { isSessionNotFoundError, SESSION_DETAIL_STALE_TIME_MS, useSession } from './useSession'

describe('isSessionNotFoundError', () => {
    it('matches hub 404 session responses', () => {
        expect(isSessionNotFoundError(new Error('HTTP 404 Not Found: {"error":"Session not found"}'))).toBe(true)
    })

    it('does not match unrelated errors', () => {
        expect(isSessionNotFoundError(new Error('HTTP 500 Internal Server Error'))).toBe(false)
        expect(isSessionNotFoundError(null)).toBe(false)
    })
})

describe('SESSION_DETAIL_STALE_TIME_MS', () => {
    // SSE patches the cache directly on session-updated events, so the REST
    // endpoint is just a cold-start / reconnect-recovery path.  A long staleTime
    // suppresses focus-refetch and remount-refetch storms — primary lever for
    // the refetch-storm fix (tiann/hapi#884).
    it('is set to a value that suppresses focus/mount refetches', () => {
        expect(SESSION_DETAIL_STALE_TIME_MS).toBeGreaterThanOrEqual(10_000)
    })
})

function makeSession(
    seq: number,
    lastAssistantMessageAt: number | null,
    metadataVersion = 1
): Session {
    return {
        id: 's1',
        namespace: 'default',
        seq,
        createdAt: 1,
        updatedAt: 9_000,
        lastAssistantMessageAt,
        active: false,
        activeAt: 9_000,
        metadata: null,
        metadataVersion,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default'
    } as Session
}

function queryWrapper(queryClient: QueryClient) {
    return ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useSession REST ordering', () => {
    it('refetches detail when the list watermark advances', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
            sessions: [{ id: 's1', lastAssistantMessageVersion: 4 } as SessionSummary]
        })
        const getSession = vi.fn()
            .mockResolvedValueOnce({ session: makeSession(4, 1_000) })
            .mockResolvedValueOnce({ session: makeSession(5, 5_000) })
        const api = { getSession } as unknown as ApiClient
        const { result } = renderHook(() => useSession(api, 's1'), { wrapper: queryWrapper(queryClient) })

        await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1))
        act(() => {
            queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
                sessions: [{ id: 's1', lastAssistantMessageVersion: 5 } as SessionSummary]
            })
        })
        await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(result.current.session?.seq).toBe(5))
    })

    it('scopes watermark refresh attempts to the selected session', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
            sessions: [
                { id: 's1', lastAssistantMessageVersion: 5 } as SessionSummary,
                { id: 's2', lastAssistantMessageVersion: 5 } as SessionSummary,
            ]
        })
        const getSession = vi.fn(async (sessionId: string) => ({ session: { ...makeSession(4, 1_000), id: sessionId } }))
        const api = { getSession } as unknown as ApiClient
        const { result, rerender } = renderHook(
            ({ sessionId }: { sessionId: string }) => useSession(api, sessionId),
            { initialProps: { sessionId: 's1' }, wrapper: queryWrapper(queryClient) }
        )

        await waitFor(() => expect(getSession).toHaveBeenCalled())
        rerender({ sessionId: 's2' })
        await waitFor(() => expect(getSession.mock.calls.filter(([id]) => id === 's2').length).toBeGreaterThanOrEqual(1))
        expect(result.current.session).toBeNull()
    })

    it('does not cache a stale detail when only the list watermark is newer', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
            sessions: [{ id: 's1', lastAssistantMessageVersion: 5 } as SessionSummary]
        })
        const getSession = vi.fn(async () => ({ session: makeSession(4, 1_000) }))
        const api = { getSession } as unknown as ApiClient
        const { result } = renderHook(
            ({ sessionId }: { sessionId: string | null }) => useSession(api, sessionId),
            { initialProps: { sessionId: 's1' as string | null }, wrapper: queryWrapper(queryClient) }
        )

        await act(async () => { await result.current.refetch() })
        await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 })
        await waitFor(() => expect(result.current.error).toBe('Session detail response is older than the cached session list'), { timeout: 5_000 })

        expect(queryClient.getQueryData<SessionResponse>(queryKeys.session('s1'))).toBeUndefined()
    })

    it('does not let a delayed REST response overwrite a newer SSE detail', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const key = queryKeys.session('s1')
        queryClient.setQueryData<SessionResponse>(key, { session: makeSession(8, 9_000, 1) })

        let resolveFirstResponse!: (response: SessionResponse) => void
        let resolveSecondResponse!: (response: SessionResponse) => void
        const firstResponse = new Promise<SessionResponse>((resolve) => { resolveFirstResponse = resolve })
        const secondResponse = new Promise<SessionResponse>((resolve) => { resolveSecondResponse = resolve })
        const responses = [firstResponse, secondResponse]
        const api = {
            getSession: vi.fn(() => responses.shift()!)
        } as unknown as ApiClient
        const { result } = renderHook(() => useSession(api, 's1'), { wrapper: queryWrapper(queryClient) })

        let refetch!: Promise<unknown>
        await act(async () => { refetch = result.current.refetch() })
        await waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(1))

        // The SSE correction arrives while the REST request is still pending.
        queryClient.setQueryData<SessionResponse>(key, { session: makeSession(10, null, 1) })
        resolveFirstResponse({ session: makeSession(9, 1_000, 2) })
        await waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(2))
        resolveSecondResponse({ session: makeSession(10, null, 2) })
        await act(async () => { await refetch })

        expect(queryClient.getQueryData<SessionResponse>(key)?.session).toEqual(makeSession(10, null, 2))
    })

    it('rejects a cached detail that is older than the list watermark', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
            sessions: [{ id: 's1', lastAssistantMessageVersion: 5 } as SessionSummary]
        })
        queryClient.setQueryData<SessionResponse>(queryKeys.session('s1'), { session: makeSession(4, 1_000) })
        const getSession = vi.fn(async () => ({ session: makeSession(4, 1_000) }))
        const api = { getSession } as unknown as ApiClient
        const { result } = renderHook(
            ({ sessionId }: { sessionId: string | null }) => useSession(api, sessionId),
            { initialProps: { sessionId: 's1' as string | null }, wrapper: queryWrapper(queryClient) }
        )

        await act(async () => { await result.current.refetch() })
        await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 15_000 })
        await waitFor(() => expect(result.current.error).toBe('Session detail response is older than the cached session list'), { timeout: 15_000 })
        expect(result.current.session).toBeNull()
        expect(queryClient.getQueryData<SessionResponse>(queryKeys.session('s1'))?.session.seq).toBe(4)
    })
})
