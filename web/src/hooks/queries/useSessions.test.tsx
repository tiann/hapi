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
