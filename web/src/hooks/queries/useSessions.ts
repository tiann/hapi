import { useQuery, useQueryClient } from '@tanstack/react-query'
import { compareSessionSummaries } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export type UseSessionsOptions = {
    enabled?: boolean
}

export function useSessions(api: ApiClient | null, options: UseSessionsOptions = {}): {
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
            const response = await api.getSessions()
            // SSE may have delivered newer input while this GET was in flight.
            // Retain its monotonic ordering clock, not deleted rows or stale data.
            const current = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            const clocks = new Map(current?.sessions.map(s => [s.id, s.lastUserMessageAt]))
            return {
                ...response,
                sessions: response.sessions.map(session => {
                    const at = clocks.get(session.id)
                    return at !== undefined && at > (session.lastUserMessageAt ?? -Infinity)
                        ? { ...session, lastUserMessageAt: at }
                        : session
                }).sort(compareSessionSummaries)
            }
        },
        enabled: Boolean(api) && (options.enabled ?? true),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
