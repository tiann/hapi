import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from './useSessions'

function makeSummary(
    id: string,
    lastAssistantMessageAt: number | null,
    lastAssistantMessageVersion: number,
    metadataVersion = 1
): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 9_000,
        updatedAt: 9_000,
        lastAssistantMessageAt,
        lastAssistantMessageVersion,
        metadata: null,
        metadataVersion,
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
        modelReasoningEffort: null,
        effort: null
    }
}

function queryWrapper(queryClient: QueryClient) {
    return ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useSessions REST ordering', () => {
    it('keeps newer SSE rows when a delayed REST list response arrives', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false, staleTime: 30_000 } }
        })
        const key = queryKeys.sessions
        queryClient.setQueryData<SessionsResponse>(key, {
            sessions: [
                makeSummary('reply', 9_000, 2, 1),
                makeSummary('other', 2_000, 1)
            ]
        })

        let resolveFirstResponse!: (response: SessionsResponse) => void
        let resolveSecondResponse!: (response: SessionsResponse) => void
        const firstResponse = new Promise<SessionsResponse>((resolve) => { resolveFirstResponse = resolve })
        const secondResponse = new Promise<SessionsResponse>((resolve) => { resolveSecondResponse = resolve })
        const responses = [firstResponse, secondResponse]
        const api = {
            getSessions: vi.fn(() => responses.shift()!)
        } as unknown as ApiClient
        const { result } = renderHook(() => useSessions(api), { wrapper: queryWrapper(queryClient) })

        let refetch!: Promise<unknown>
        await act(async () => { refetch = result.current.refetch() })
        await waitFor(() => expect(api.getSessions).toHaveBeenCalledTimes(1))

        // A newer reply event reorders the row before the REST request settles.
        queryClient.setQueryData<SessionsResponse>(key, {
            sessions: [
                makeSummary('reply', 10_000, 3, 1),
                makeSummary('other', 2_000, 1)
            ]
        })
        resolveFirstResponse({
            sessions: [
                makeSummary('reply', 1_000, 2, 2),
                makeSummary('other', 2_000, 1)
            ]
        })
        await waitFor(() => expect(api.getSessions).toHaveBeenCalledTimes(2))
        resolveSecondResponse({
            sessions: [
                makeSummary('reply', 10_000, 3, 2),
                makeSummary('other', 2_000, 1)
            ]
        })
        await act(async () => { await refetch })

        expect(queryClient.getQueryData<SessionsResponse>(key)?.sessions.map((session) => session.id))
            .toEqual(['reply', 'other'])
        await waitFor(() => {
            expect(result.current.sessions[0]?.lastAssistantMessageAt).toBe(10_000)
            expect(result.current.sessions[0]?.metadataVersion).toBe(2)
        })
    })
})
