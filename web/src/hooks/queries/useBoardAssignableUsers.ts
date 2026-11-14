import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { BoardAssignableUser } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const EMPTY_USERS: BoardAssignableUser[] = []

// `enabled` is driven by the caller (the assignee picker popover's own open
// state), not just api/boardId/url presence — fetching every item's
// assignable-users list eagerly on every board render would mean one
// GraphQL call per visible item, for data nobody may ever open the picker
// to see (design-consult review, hapi#238).
export function useBoardAssignableUsers(
    api: ApiClient | null,
    boardId: string | null,
    itemUrl: string | null,
    enabled: boolean,
    search = ''
): {
    users: BoardAssignableUser[]
    isLoading: boolean
    error: string | null
} {
    const query = useQuery({
        queryKey: queryKeys.boardAssignableUsers(boardId ?? '', itemUrl ?? '', search),
        queryFn: async () => {
            if (!api || !boardId || !itemUrl) {
                throw new Error('API unavailable')
            }
            return await api.getBoardItemAssignableUsers(boardId, itemUrl, search || undefined)
        },
        enabled: Boolean(api && boardId && itemUrl && enabled),
    })

    return {
        users: query.data?.users ?? EMPTY_USERS,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load assignable users' : null,
    }
}
