import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { BoardItem } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

// Stable references so consumers' useMemo/useCallback deps don't churn every
// render while the query is loading (a fresh `?? []` allocates a new array
// each time).
const EMPTY_ITEMS: BoardItem[] = []
const EMPTY_STRINGS: string[] = []

export function useBoardItems(api: ApiClient | null, boardId: string | null): {
    items: BoardItem[]
    statusOrder: string[]
    doneValues: string[]
    isLoading: boolean
    isRefetching: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.boardItems(boardId ?? ''),
        queryFn: async () => {
            if (!api || !boardId) {
                throw new Error('API unavailable')
            }
            return await api.getBoardItems(boardId)
        },
        enabled: Boolean(api && boardId),
        // Deliberately no polling/refetchInterval (operator decision,
        // 2026-10-11, matching the original design doc's non-goal): GitHub
        // Projects reads are heavier than a REST poll, so staleness is
        // handled by an explicit refresh action in the UI instead of
        // hammering the API on an interval.
    })

    return {
        items: query.data?.items ?? EMPTY_ITEMS,
        statusOrder: query.data?.statusOrder ?? EMPTY_STRINGS,
        doneValues: query.data?.doneValues ?? EMPTY_STRINGS,
        isLoading: query.isLoading,
        isRefetching: query.isRefetching,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load board items' : null,
        refetch: query.refetch,
    }
}
