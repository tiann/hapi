import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { reconcileAttachedJobsFromCache } from './reconcileAttachedJobs'

export function useSessions(api: ApiClient | null): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const fetched = await api.getSessions()
            const cached = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            return reconcileAttachedJobsFromCache(fetched, cached)
        },
        enabled: Boolean(api),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
