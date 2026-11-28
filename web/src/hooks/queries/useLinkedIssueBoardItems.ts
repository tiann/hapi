import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { BoardItem } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useBoards } from './useBoards'

const EMPTY_ITEMS: BoardItem[] = []

export type BoardWithItems = { boardId: string; boardLabel: string; items: BoardItem[] }

/**
 * Every configured board's items, fetched only while `enabled` — gated by
 * the caller on "is there at least one visible session with a linked GitHub
 * issue to resolve" (router.tsx), not on Boards mode being active, since the
 * whole point is answering "is this session's issue tracked on a board?"
 * from Sessions mode (operator follow-up to hapi#238, via Fekko: the board
 * -> session jump already existed one-directionally).
 *
 * Reuses `queryKeys.boards` and `queryKeys.boardItems(id)` — the exact same
 * cache keys `useBoards`/`useBoardItems` use for the Boards-mode views — so
 * this never double-fetches alongside Boards mode, and switching into
 * Boards mode for a board already resolved here is an instant cache hit.
 */
export function useLinkedIssueBoardItems(api: ApiClient | null, enabled: boolean): BoardWithItems[] {
    const { boards } = useBoards(api, enabled)

    const itemQueries = useQueries({
        queries: boards.map(board => ({
            queryKey: queryKeys.boardItems(board.id),
            queryFn: async () => {
                if (!api) {
                    throw new Error('API unavailable')
                }
                return await api.getBoardItems(board.id)
            },
            enabled: Boolean(api) && enabled,
        })),
    })

    // `boards` is reference-stable while its data is unchanged (see useBoards).
    // `itemQueries` itself is a fresh array every render, so its length can't
    // be used directly as a useMemo dep array (useMemo requires a constant
    // size); a single scalar signature from each query's last-success
    // timestamp keeps the deps array fixed at 2 while still invalidating the
    // memo exactly when a board's items actually change — otherwise this
    // would return a new array every render regardless of whether query data
    // changed, cascading through getBoardMatchForIssue/context/props and
    // defeating SessionItem's memoization on every unrelated session update.
    const itemsVersionKey = itemQueries.map(query => query.dataUpdatedAt).join(',')

    return useMemo(
        () => boards.map((board, index) => ({
            boardId: board.id,
            boardLabel: board.label,
            items: itemQueries[index]?.data?.items ?? EMPTY_ITEMS,
        })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [boards, itemsVersionKey]
    )
}
