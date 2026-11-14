import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useBoardActions } from './useBoardActions'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'
import type { BoardsResponse } from '@/types/api'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useBoardActions', () => {
    it('addBoard writes the response straight into the todo-boards cache', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const response: BoardsResponse = { boards: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
        const addBoard = vi.fn().mockResolvedValue(response)
        const api = { addBoard } as unknown as ApiClient

        const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

        await act(async () => {
            await result.current.addBoard('https://github.com/users/heavygee/projects/6')
        })

        expect(addBoard).toHaveBeenCalledWith('https://github.com/users/heavygee/projects/6')
        expect(queryClient.getQueryData(queryKeys.boards)).toEqual(response)
    })

    it('removeBoard writes the response straight into the todo-boards cache', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const response: BoardsResponse = { boards: [{ id: 'a', label: 'A' }] }
        const removeBoard = vi.fn().mockResolvedValue(response)
        const api = { removeBoard } as unknown as ApiClient

        const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

        await act(async () => {
            await result.current.removeBoard('b')
        })

        expect(removeBoard).toHaveBeenCalledWith('b')
        expect(queryClient.getQueryData(queryKeys.boards)).toEqual(response)
    })

    it('removeBoard evicts the removed board\'s cached items, not just the board list', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        queryClient.setQueryData(queryKeys.boardItems('b'), { items: [{ id: 'stale-item' }] })
        const response: BoardsResponse = { boards: [{ id: 'a', label: 'A' }] }
        const removeBoard = vi.fn().mockResolvedValue(response)
        const api = { removeBoard } as unknown as ApiClient

        const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

        await act(async () => {
            await result.current.removeBoard('b')
        })

        expect(queryClient.getQueryData(queryKeys.boardItems('b'))).toBeUndefined()
    })

    it('rejects without touching the api client when api is null', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const { result } = renderHook(() => useBoardActions(null), { wrapper: createWrapper(queryClient) })

        await expect(result.current.addBoard('https://github.com/users/heavygee/projects/6')).rejects.toThrow('API unavailable')
        await expect(result.current.removeBoard('a')).rejects.toThrow('API unavailable')
    })

    it('createBoardItem returns the created url, caches the confirmed item list, and invalidates every board\'s items', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const createdUrl = 'https://github.com/heavygee/hapi/issues/42'
        const createBoardItem = vi.fn().mockResolvedValue({ ok: true, url: createdUrl })
        const itemsWithCreated = { items: [{ url: createdUrl }], statusOrder: [], doneValues: [] }
        const getBoardItems = vi.fn().mockResolvedValue(itemsWithCreated)
        const api = { createBoardItem, getBoardItems } as unknown as ApiClient

        const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

        const payload = { repo: 'heavygee/hapi', title: 'New bug', body: 'Broke.', labels: ['bug'], assignees: [] }
        let url: string | undefined
        await act(async () => {
            url = await result.current.createBoardItem('board-1', payload)
        })

        expect(createBoardItem).toHaveBeenCalledWith('board-1', payload)
        expect(url).toBe(createdUrl)
        expect(getBoardItems).toHaveBeenCalledWith('board-1')
        expect(queryClient.getQueryData(queryKeys.boardItems('board-1'))).toEqual(itemsWithCreated)
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.boardItemsAll })
    })

    // GitHub Projects v2 has a real propagation lag between the hub's own
    // project-add succeeding and the item actually appearing in a
    // subsequent items query (operator report, hapi#247: created the issue,
    // it never showed up on the board — confirmed by hand the item really
    // was added, just not indexed yet). A single invalidate+refetch right
    // after create can lose that race and silently show the board without
    // the just-created item.
    it('polls until the created item actually appears, instead of trusting a single refetch', async () => {
        vi.useFakeTimers()
        try {
            const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
            const createdUrl = 'https://github.com/heavygee/hapi/issues/42'
            const createBoardItem = vi.fn().mockResolvedValue({ ok: true, url: createdUrl })
            const staleItems = { items: [], statusOrder: [], doneValues: [] }
            const freshItems = { items: [{ url: createdUrl }], statusOrder: [], doneValues: [] }
            const getBoardItems = vi.fn()
                .mockResolvedValueOnce(staleItems)
                .mockResolvedValueOnce(staleItems)
                .mockResolvedValueOnce(freshItems)
            const api = { createBoardItem, getBoardItems } as unknown as ApiClient

            const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

            const payload = { repo: 'heavygee/hapi', title: 'New bug', body: 'Broke.', labels: ['bug'], assignees: [] }
            let url: string | undefined
            const pending = result.current.createBoardItem('board-1', payload).then(resolved => { url = resolved })
            await vi.advanceTimersByTimeAsync(2000)
            await vi.advanceTimersByTimeAsync(2000)
            await pending

            expect(getBoardItems).toHaveBeenCalledTimes(3)
            expect(url).toBe(createdUrl)
            expect(queryClient.getQueryData(queryKeys.boardItems('board-1'))).toEqual(freshItems)
        } finally {
            vi.useRealTimers()
        }
    })

    it('gives up polling after 20s and still resolves, rather than hanging forever', async () => {
        vi.useFakeTimers()
        try {
            const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
            const createdUrl = 'https://github.com/heavygee/hapi/issues/42'
            const createBoardItem = vi.fn().mockResolvedValue({ ok: true, url: createdUrl })
            const neverFound = { items: [], statusOrder: [], doneValues: [] }
            const getBoardItems = vi.fn().mockResolvedValue(neverFound)
            const api = { createBoardItem, getBoardItems } as unknown as ApiClient

            const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

            const payload = { repo: 'heavygee/hapi', title: 'New bug', body: 'Broke.', labels: ['bug'], assignees: [] }
            let url: string | undefined
            const pending = result.current.createBoardItem('board-1', payload).then(resolved => { url = resolved })
            for (let i = 0; i < 11; i++) {
                await vi.advanceTimersByTimeAsync(2000)
            }
            await pending

            expect(url).toBe(createdUrl)
            expect(queryClient.getQueryData(queryKeys.boardItems('board-1'))).toEqual(neverFound)
        } finally {
            vi.useRealTimers()
        }
    })

    it('createBoardItem rejects without touching the api client when api is null', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const { result } = renderHook(() => useBoardActions(null), { wrapper: createWrapper(queryClient) })

        await expect(result.current.createBoardItem('board-1', { repo: 'a/b', title: 'T', body: 'B', labels: [], assignees: [] }))
            .rejects.toThrow('API unavailable')
    })

    // Review finding (both forks, independently): the create+add writes
    // already succeeded by the time polling starts — a transient failure
    // fetching board items to confirm it must not surface as a creation
    // failure, or the operator sees an error with no sign the issue already
    // exists and a retry files a duplicate.
    it('still resolves with the created url when the very first polling fetch rejects', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const createdUrl = 'https://github.com/heavygee/hapi/issues/42'
        const createBoardItem = vi.fn().mockResolvedValue({ ok: true, url: createdUrl })
        const getBoardItems = vi.fn().mockRejectedValue(new Error('HTTP 502'))
        const api = { createBoardItem, getBoardItems } as unknown as ApiClient

        const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

        const payload = { repo: 'heavygee/hapi', title: 'New bug', body: 'Broke.', labels: ['bug'], assignees: [] }
        const url = await result.current.createBoardItem('board-1', payload)

        expect(url).toBe(createdUrl)
        expect(queryClient.getQueryData(queryKeys.boardItems('board-1'))).toBeUndefined()
    })

    it('still resolves with the created url when a later polling retry rejects', async () => {
        vi.useFakeTimers()
        try {
            const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
            const createdUrl = 'https://github.com/heavygee/hapi/issues/42'
            const createBoardItem = vi.fn().mockResolvedValue({ ok: true, url: createdUrl })
            const staleItems = { items: [], statusOrder: [], doneValues: [] }
            const getBoardItems = vi.fn()
                .mockResolvedValueOnce(staleItems)
                .mockRejectedValueOnce(new Error('network error'))
            const api = { createBoardItem, getBoardItems } as unknown as ApiClient

            const { result } = renderHook(() => useBoardActions(api), { wrapper: createWrapper(queryClient) })

            const payload = { repo: 'heavygee/hapi', title: 'New bug', body: 'Broke.', labels: ['bug'], assignees: [] }
            let url: string | undefined
            const pending = result.current.createBoardItem('board-1', payload).then(resolved => { url = resolved })
            await vi.advanceTimersByTimeAsync(2000)
            await pending

            expect(url).toBe(createdUrl)
            expect(queryClient.getQueryData(queryKeys.boardItems('board-1'))).toBeUndefined()
        } finally {
            vi.useRealTimers()
        }
    })
})
