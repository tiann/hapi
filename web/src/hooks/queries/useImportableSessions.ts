import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ImportableSessionAgent, ImportableSessionView } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useImportableSessions(
    api: ApiClient | null,
    agent: ImportableSessionAgent,
    enabled: boolean
): {
    sessions: ImportableSessionView[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.importableSessions(agent),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.listImportableSessions(agent)
        },
        enabled: Boolean(api) && enabled,
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading || query.isFetching,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load importable sessions' : null,
        refetch: query.refetch,
    }
}
