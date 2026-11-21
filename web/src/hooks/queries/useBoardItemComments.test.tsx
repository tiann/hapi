import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useBoardItemComments } from './useBoardItemComments'
import type { ApiClient } from '@/api/client'
import type { BoardItemCommentsResponse } from '@/types/api'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useBoardItemComments', () => {
    it('fetches comments for the given board/item and returns them', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const response: BoardItemCommentsResponse = {
            comments: [{
                id: 'IC_1',
                author: { login: 'octocat', avatarUrl: 'https://example.com/octocat.png' },
                authorAssociation: 'MEMBER',
                body: 'Looks good to me',
                createdAt: '2026-10-27T00:00:00Z',
                url: 'https://github.com/acme/widgets/issues/1#issuecomment-1',
                isMinimized: false,
                minimizedReason: null
            }]
        }
        const getBoardItemComments = vi.fn().mockResolvedValue(response)
        const api = { getBoardItemComments } as unknown as ApiClient

        const { result } = renderHook(
            () => useBoardItemComments(api, 'board-1', 'https://github.com/acme/widgets/issues/1'),
            { wrapper: createWrapper(queryClient) }
        )

        await waitFor(() => expect(result.current.comments).toEqual(response.comments))
        expect(getBoardItemComments).toHaveBeenCalledWith('board-1', 'https://github.com/acme/widgets/issues/1')
    })

    it('does not fetch when there is no item url', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const getBoardItemComments = vi.fn()
        const api = { getBoardItemComments } as unknown as ApiClient

        const { result } = renderHook(
            () => useBoardItemComments(api, 'board-1', null),
            { wrapper: createWrapper(queryClient) }
        )

        expect(getBoardItemComments).not.toHaveBeenCalled()
        expect(result.current.comments).toEqual([])
    })

    it('refetches on demand, reporting isRefetching while the request is in flight', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const response: BoardItemCommentsResponse = {
            comments: [{
                id: 'IC_1',
                author: { login: 'octocat', avatarUrl: 'https://example.com/octocat.png' },
                authorAssociation: 'MEMBER',
                body: 'Looks good to me',
                createdAt: '2026-10-27T00:00:00Z',
                url: 'https://github.com/acme/widgets/issues/1#issuecomment-1',
                isMinimized: false,
                minimizedReason: null
            }]
        }
        const getBoardItemComments = vi.fn().mockResolvedValue(response)
        const api = { getBoardItemComments } as unknown as ApiClient

        const { result } = renderHook(
            () => useBoardItemComments(api, 'board-1', 'https://github.com/acme/widgets/issues/1'),
            { wrapper: createWrapper(queryClient) }
        )
        await waitFor(() => expect(result.current.comments).toEqual(response.comments))
        expect(getBoardItemComments).toHaveBeenCalledTimes(1)

        result.current.refetch()
        await waitFor(() => expect(getBoardItemComments).toHaveBeenCalledTimes(2))
    })

    it('maps a fetch failure to a readable error message', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const getBoardItemComments = vi.fn().mockRejectedValue(new Error('network down'))
        const api = { getBoardItemComments } as unknown as ApiClient

        const { result } = renderHook(
            () => useBoardItemComments(api, 'board-1', 'https://github.com/acme/widgets/issues/1'),
            { wrapper: createWrapper(queryClient) }
        )

        await waitFor(() => expect(result.current.error).toBe('network down'))
    })
})
