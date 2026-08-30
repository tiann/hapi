import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session, SessionResponse, SessionSummary, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionsResponse, needsSessionsResponseRetry } from '@/lib/sessionCache'

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
            const getCachedDetail = (sessionId: string): Session | undefined =>
                queryClient.getQueryData<SessionResponse>(queryKeys.session(sessionId))?.session
            let incoming = await api.getSessions()
            let current = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            if (needsSessionsResponseRetry(current, incoming, getCachedDetail)) {
                // Recover unrelated row fields after discarding a stale list
                // snapshot, while keeping the retry bounded to one request.
                incoming = await api.getSessions()
                current = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions) ?? current
            }
            return mergeSessionsResponse(current, incoming, getCachedDetail)
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
