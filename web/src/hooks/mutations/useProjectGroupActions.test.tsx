import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useProjectGroupActions } from './useProjectGroupActions'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@hapi/protocol/types'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
    return {
        id: 'session-1',
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 1,
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
        ...overrides,
    }
}

const runningSession = (id: string) => makeSession({
    id,
    active: true,
    metadata: { path: '/p', lifecycleState: 'running' }
})
const archivedSession = (id: string) => makeSession({
    id,
    active: false,
    metadata: { path: '/p', lifecycleState: 'archived' }
})

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('useProjectGroupActions', () => {
    it('archives only archivable sessions in order', async () => {
        const archive = vi.fn(async () => {})
        const api = { archiveSession: archive } as unknown as ApiClient
        const sessions = [runningSession('a'), archivedSession('b'), runningSession('c')]

        const { result } = renderHook(
            () => useProjectGroupActions(api, sessions),
            { wrapper: createWrapper() }
        )

        await act(async () => {
            await result.current.archiveAll()
        })

        expect(archive).toHaveBeenCalledTimes(2)
        expect(archive).toHaveBeenNthCalledWith(1, 'a')
        expect(archive).toHaveBeenNthCalledWith(2, 'c')
    })

    it('retries a member whose archive failed after SSE marked it archived, across a remount', async () => {
        const archive = vi.fn(async (_id: string) => {})
        archive.mockRejectedValueOnce(new Error('cleanup unconfirmed'))
        const api = { archiveSession: archive } as unknown as ApiClient
        const wrapper = createWrapper()

        const first = renderHook(
            () => useProjectGroupActions(api, [runningSession('a'), runningSession('b')]),
            { wrapper }
        )
        await act(async () => {
            await expect(first.result.current.archiveAll()).rejects.toThrow('cleanup unconfirmed')
        })
        // A filter hides the group header; it comes back with 'a' archived via SSE.
        first.unmount()
        const { result } = renderHook(
            () => useProjectGroupActions(api, [archivedSession('a'), runningSession('b')]),
            { wrapper }
        )
        expect(result.current.hasUnconfirmedArchive).toBe(true)

        await act(async () => {
            await result.current.archiveAll()
        })

        expect(archive.mock.calls.map(([id]) => id)).toEqual(['a', 'a', 'b'])
        await waitFor(() => expect(result.current.hasUnconfirmedArchive).toBe(false))
    })

    it('deletes the group through the atomic archived bulk route', async () => {
        const deleteFn = vi.fn(async () => {})
        const api = { deleteArchivedSessions: deleteFn } as unknown as ApiClient
        const sessions = [archivedSession('a'), archivedSession('b')]

        const { result } = renderHook(
            () => useProjectGroupActions(api, sessions),
            { wrapper: createWrapper() }
        )

        await act(async () => {
            await result.current.deleteGroup()
        })

        expect(deleteFn).toHaveBeenCalledWith({
            sessionIds: ['a', 'b'],
            requireAllArchived: true,
        })
    })

    it('throws when api is missing', async () => {
        const { result } = renderHook(
            () => useProjectGroupActions(null, []),
            { wrapper: createWrapper() }
        )

        await expect(result.current.archiveAll()).rejects.toThrow('Session unavailable')
        await expect(result.current.deleteGroup()).rejects.toThrow('Session unavailable')
    })
})
