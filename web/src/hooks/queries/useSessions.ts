import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { getBrowserAppBadgeTarget, getTotalUnreadCountFromSessions, updateAppBadge } from '@/lib/appBadge'
import { queryKeys } from '@/lib/query-keys'

export function useSessions(api: ApiClient | null): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getSessions()
        },
        enabled: Boolean(api),
        staleTime: 30_000,
    })

    useEffect(() => {
        if (!query.data) {
            return
        }
        const totalUnreadCount = getTotalUnreadCountFromSessions(query.data.sessions)
        void updateAppBadge(getBrowserAppBadgeTarget(), totalUnreadCount)
    }, [query.data])

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
