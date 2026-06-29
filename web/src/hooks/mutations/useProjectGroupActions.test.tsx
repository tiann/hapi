import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useProjectGroupActions } from './useProjectGroupActions'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
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
    }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('useProjectGroupActions - archiveAll', () => {
    it('archives only archivable sessions, leaving already-archived ones untouched', async () => {
        const archiveSession = vi.fn(async (_id: string) => {})
        const api = { archiveSession } as unknown as ApiClient
        const sessions = [
            makeSession({ id: 'live', active: true, metadata: { path: '/p', lifecycleState: 'running' } }),
            makeSession({ id: 'done', metadata: { path: '/p', lifecycleState: 'archived' } }),
            makeSession({ id: 'split', metadata: { path: '/p', lifecycleState: 'running' } }),
        ]

        const { result } = renderHook(() => useProjectGroupActions(api, sessions), { wrapper: createWrapper() })

        await act(async () => {
            await result.current.archiveAll()
        })

        expect(archiveSession).toHaveBeenCalledTimes(2)
        expect(archiveSession).toHaveBeenCalledWith('live')
        expect(archiveSession).toHaveBeenCalledWith('split')
        expect(archiveSession).not.toHaveBeenCalledWith('done')
    })

    it('throws when api is missing', async () => {
        const { result } = renderHook(() => useProjectGroupActions(null, []), { wrapper: createWrapper() })
        await expect(result.current.archiveAll()).rejects.toThrow('Session unavailable')
    })
})

describe('useProjectGroupActions - deleteAll', () => {
    it('deletes every session in the group sequentially', async () => {
        const deleteSession = vi.fn(async (_id: string) => {})
        const api = { deleteSession } as unknown as ApiClient
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', lifecycleState: 'archived' } }),
            makeSession({ id: 'b', metadata: { path: '/p', lifecycleState: 'archived' } }),
        ]

        const { result } = renderHook(() => useProjectGroupActions(api, sessions), { wrapper: createWrapper() })

        await act(async () => {
            await result.current.deleteAll()
        })

        expect(deleteSession).toHaveBeenCalledTimes(2)
        expect(deleteSession).toHaveBeenNthCalledWith(1, 'a')
        expect(deleteSession).toHaveBeenNthCalledWith(2, 'b')
    })

    it('aborts the run when a delete rejects mid-loop', async () => {
        const deleteSession = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('409 active'))
        const api = { deleteSession } as unknown as ApiClient
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', lifecycleState: 'archived' } }),
            makeSession({ id: 'b', metadata: { path: '/p', lifecycleState: 'archived' } }),
            makeSession({ id: 'c', metadata: { path: '/p', lifecycleState: 'archived' } }),
        ]

        const { result } = renderHook(() => useProjectGroupActions(api, sessions), { wrapper: createWrapper() })

        await act(async () => {
            await expect(result.current.deleteAll()).rejects.toThrow('409 active')
        })

        // Third session never reached after the second rejected.
        expect(deleteSession).toHaveBeenCalledTimes(2)
    })
})
