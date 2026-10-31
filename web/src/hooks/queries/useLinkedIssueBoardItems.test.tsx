import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useLinkedIssueBoardItems } from './useLinkedIssueBoardItems'
import type { ApiClient } from '@/api/client'
import type { BoardItemsResponse, BoardsResponse } from '@/types/api'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useLinkedIssueBoardItems', () => {
    it('does not fetch boards or items when disabled', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const getBoards = vi.fn()
        const getBoardItems = vi.fn()
        const api = { getBoards, getBoardItems } as unknown as ApiClient

        renderHook(() => useLinkedIssueBoardItems(api, false), { wrapper: createWrapper(queryClient) })

        expect(getBoards).not.toHaveBeenCalled()
        expect(getBoardItems).not.toHaveBeenCalled()
    })

    it('fetches items for every configured board and tags each with its board id/label', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const boardsResponse: BoardsResponse = { boards: [{ id: 'board-1', label: 'Board One' }, { id: 'board-2', label: 'Board Two' }] }
        const itemsByBoard: Record<string, BoardItemsResponse> = {
            'board-1': { board: boardsResponse.boards[0]!, statusOrder: ['Todo'], doneValues: [], items: [{ id: 'item-1' } as BoardItemsResponse['items'][number]] },
            'board-2': { board: boardsResponse.boards[1]!, statusOrder: ['Todo'], doneValues: [], items: [] },
        }
        const api = {
            getBoards: vi.fn().mockResolvedValue(boardsResponse),
            getBoardItems: vi.fn((boardId: string) => Promise.resolve(itemsByBoard[boardId])),
        } as unknown as ApiClient

        const { result } = renderHook(() => useLinkedIssueBoardItems(api, true), { wrapper: createWrapper(queryClient) })

        await waitFor(() => expect(result.current).toEqual([
            { boardId: 'board-1', boardLabel: 'Board One', items: itemsByBoard['board-1']!.items },
            { boardId: 'board-2', boardLabel: 'Board Two', items: [] },
        ]))
        expect(api.getBoardItems).toHaveBeenCalledWith('board-1')
        expect(api.getBoardItems).toHaveBeenCalledWith('board-2')
    })

    it('returns an empty-items entry for a board whose items have not resolved yet', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const boardsResponse: BoardsResponse = { boards: [{ id: 'board-1', label: 'Board One' }] }
        const api = {
            getBoards: vi.fn().mockResolvedValue(boardsResponse),
            getBoardItems: vi.fn(() => new Promise(() => {})),
        } as unknown as ApiClient

        const { result } = renderHook(() => useLinkedIssueBoardItems(api, true), { wrapper: createWrapper(queryClient) })

        await waitFor(() => expect(result.current).toEqual([{ boardId: 'board-1', boardLabel: 'Board One', items: [] }]))
    })

    it('returns an empty array before the boards list itself has resolved', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const api = {
            getBoards: vi.fn(() => new Promise(() => {})),
            getBoardItems: vi.fn(),
        } as unknown as ApiClient

        const { result } = renderHook(() => useLinkedIssueBoardItems(api, true), { wrapper: createWrapper(queryClient) })

        expect(result.current).toEqual([])
        expect(api.getBoardItems).not.toHaveBeenCalled()
    })
})
