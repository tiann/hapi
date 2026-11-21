import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { BoardItemComment } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const EMPTY_COMMENTS: BoardItemComment[] = []

export function useBoardItemComments(
    api: ApiClient | null,
    boardId: string | null,
    itemUrl: string | null
): {
    comments: BoardItemComment[]
    isLoading: boolean
    isRefetching: boolean
    error: string | null
    refetch: () => void
} {
    const query = useQuery({
        queryKey: queryKeys.boardItemComments(boardId ?? '', itemUrl ?? ''),
        queryFn: async () => {
            if (!api || !boardId || !itemUrl) {
                throw new Error('API unavailable')
            }
            return await api.getBoardItemComments(boardId, itemUrl)
        },
        enabled: Boolean(api && boardId && itemUrl),
    })

    return {
        comments: query.data?.comments ?? EMPTY_COMMENTS,
        isLoading: query.isLoading,
        isRefetching: query.isRefetching,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load comments' : null,
        refetch: () => { void query.refetch() },
    }
}
