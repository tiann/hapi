import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { useBoardItemActions } from './useBoardItemActions'
import { queryKeys } from '@/lib/query-keys'

function wrapper(queryClient: QueryClient) {
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

describe('useBoardItemActions', () => {
    it('closes an item and invalidates the board items query on success', async () => {
        const queryClient = new QueryClient()
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const closeBoardItem = vi.fn().mockResolvedValue(undefined)
        const api = { closeBoardItem } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        await result.current.closeItem({ url: 'https://github.com/a/b/issues/1' })

        expect(closeBoardItem).toHaveBeenCalledWith('board-1', 'https://github.com/a/b/issues/1')
        expect(invalidateSpy).toHaveBeenCalled()
    })

    it('invalidates every board\'s items cache, not just the acting board (Codex review)', async () => {
        // Regression: the same issue can be a member of more than one
        // configured board (an unfiltered project and one of its saved
        // views is an explicitly supported combination) — invalidating only
        // the acting board left any other board showing stale state, with no
        // polling to ever self-correct.
        const queryClient = new QueryClient()
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const closeBoardItem = vi.fn().mockResolvedValue(undefined)
        const api = { closeBoardItem } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        await result.current.closeItem({ url: 'https://github.com/a/b/issues/1' })

        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.boardItemsAll })
    })

    it('tracks closingUrls across the call, scoped to the acting item', async () => {
        const queryClient = new QueryClient()
        let resolveClose: () => void = () => {}
        const closeBoardItem = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve }))
        const api = { closeBoardItem } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        expect(result.current.closingUrls.size).toBe(0)

        const promise = result.current.closeItem({ url: 'https://github.com/a/b/issues/1' })
        await waitFor(() => expect(result.current.closingUrls.has('https://github.com/a/b/issues/1')).toBe(true))

        resolveClose()
        await promise
        await waitFor(() => expect(result.current.closingUrls.size).toBe(0))
    })

    it('shows two genuinely concurrent actions on different items as pending at the same time (Codex review, second pass)', async () => {
        // A single nullable slot can only ever reflect the most recently
        // started item — it couldn't show A as pending once B started, even
        // though A's own request was still genuinely in flight. A set must
        // hold both.
        const queryClient = new QueryClient()
        let resolveA: () => void = () => {}
        let resolveB: () => void = () => {}
        let callCount = 0
        const closeBoardItem = vi.fn(() => new Promise<void>((resolve) => {
            callCount += 1
            if (callCount === 1) resolveA = resolve
            else resolveB = resolve
        }))
        const api = { closeBoardItem } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })

        const promiseA = result.current.closeItem({ url: 'https://github.com/a/b/issues/1' })
        await waitFor(() => expect(result.current.closingUrls.has('https://github.com/a/b/issues/1')).toBe(true))

        const promiseB = result.current.closeItem({ url: 'https://github.com/a/b/issues/2' })
        await waitFor(() => expect(result.current.closingUrls.has('https://github.com/a/b/issues/2')).toBe(true))

        // Both still in flight — both must read as pending simultaneously.
        expect(result.current.closingUrls.has('https://github.com/a/b/issues/1')).toBe(true)
        expect(result.current.closingUrls.size).toBe(2)

        // A settles first — only A's entry is removed, B's stays.
        resolveA()
        await promiseA
        await waitFor(() => expect(result.current.closingUrls.has('https://github.com/a/b/issues/1')).toBe(false))
        expect(result.current.closingUrls.has('https://github.com/a/b/issues/2')).toBe(true)

        resolveB()
        await promiseB
        await waitFor(() => expect(result.current.closingUrls.size).toBe(0))
    })

    it('rejects without calling the API when the item has no url (draft issue)', async () => {
        const queryClient = new QueryClient()
        const closeBoardItem = vi.fn()
        const api = { closeBoardItem } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        await expect(result.current.closeItem({ url: null })).rejects.toThrow()
        expect(closeBoardItem).not.toHaveBeenCalled()
    })

    it('rejects without calling the API when there is no board selected', async () => {
        const queryClient = new QueryClient()
        const setBoardItemStatus = vi.fn()
        const api = { setBoardItemStatus } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, null), { wrapper: wrapper(queryClient) })
        await expect(result.current.setItemStatus({ url: 'https://github.com/a/b/issues/1' }, 'Done')).rejects.toThrow()
        expect(setBoardItemStatus).not.toHaveBeenCalled()
    })

    it('comments on an item and invalidates both the board items cache and that item\'s own comments cache', async () => {
        const queryClient = new QueryClient()
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const commentOnBoardItem = vi.fn().mockResolvedValue(undefined)
        const api = { commentOnBoardItem } as unknown as ApiClient
        const url = 'https://github.com/a/b/issues/1'

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        await result.current.commentOnItem({ url }, 'hi')

        expect(commentOnBoardItem).toHaveBeenCalledWith('board-1', url, 'hi')
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.boardItemsAll })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.boardItemComments('board-1', url) })
    })

    it('propagates a failed write without invalidating the query', async () => {
        const queryClient = new QueryClient()
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const commentOnBoardItem = vi.fn().mockRejectedValue(new Error('gh issue comment failed'))
        const api = { commentOnBoardItem } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        await expect(result.current.commentOnItem({ url: 'https://github.com/a/b/issues/1' }, 'hi')).rejects.toThrow('gh issue comment failed')
        expect(invalidateSpy).not.toHaveBeenCalled()
    })

    it('sets status via the API, resolving the board id and item url', async () => {
        const queryClient = new QueryClient()
        const setBoardItemStatus = vi.fn().mockResolvedValue(undefined)
        const api = { setBoardItemStatus } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        await result.current.setItemStatus({ url: 'https://github.com/a/b/issues/1' }, 'Done')

        expect(setBoardItemStatus).toHaveBeenCalledWith('board-1', 'https://github.com/a/b/issues/1', 'Done')
    })

    it('sets assignees via the API and invalidates every board\'s items cache', async () => {
        const queryClient = new QueryClient()
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const setBoardItemAssignees = vi.fn().mockResolvedValue(undefined)
        const api = { setBoardItemAssignees } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        await result.current.setItemAssignees({ url: 'https://github.com/a/b/issues/1' }, ['alice'], ['bob'])

        expect(setBoardItemAssignees).toHaveBeenCalledWith('board-1', 'https://github.com/a/b/issues/1', ['alice'], ['bob'])
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.boardItemsAll })
    })

    it('tracks settingAssigneesUrls across the call, scoped to the acting item', async () => {
        const queryClient = new QueryClient()
        let resolveSet: () => void = () => {}
        const setBoardItemAssignees = vi.fn(() => new Promise<void>((resolve) => { resolveSet = resolve }))
        const api = { setBoardItemAssignees } as unknown as ApiClient

        const { result } = renderHook(() => useBoardItemActions(api, 'board-1'), { wrapper: wrapper(queryClient) })
        expect(result.current.settingAssigneesUrls.size).toBe(0)

        const promise = result.current.setItemAssignees({ url: 'https://github.com/a/b/issues/1' }, ['alice'], [])
        await waitFor(() => expect(result.current.settingAssigneesUrls.has('https://github.com/a/b/issues/1')).toBe(true))

        resolveSet()
        await promise
        await waitFor(() => expect(result.current.settingAssigneesUrls.size).toBe(0))
    })
})
