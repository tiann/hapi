import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { BoardSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

// Stable reference so consumers' useMemo/useCallback deps don't churn every
// render while the query is loading (a fresh `?? []` allocates a new array
// each time).
const EMPTY_BOARDS: BoardSummary[] = []

export function useBoards(api: ApiClient | null, enabled: boolean): {
    boards: BoardSummary[]
    isLoading: boolean
    isRefetching: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.boards,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getBoards()
        },
        enabled: Boolean(api && enabled),
    })

    return {
        boards: query.data?.boards ?? EMPTY_BOARDS,
        isLoading: query.isLoading,
        isRefetching: query.isRefetching,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load boards' : null,
        refetch: query.refetch,
    }
}
