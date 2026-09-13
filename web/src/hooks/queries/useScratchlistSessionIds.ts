import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useScratchlistSessionIds(api: ApiClient | null, enabled: boolean): {
    sessionIds: Set<string>
    isLoading: boolean
    error: string | null
} {
    const queryEnabled = Boolean(api && enabled)
    const query = useQuery({
        queryKey: queryKeys.scratchlistSessionIds,
        queryFn: async () => {
            if (!api) {
                return []
            }
            return await api.getScratchlistSessionIds()
        },
        enabled: queryEnabled,
        staleTime: 30_000,
    })

    return {
        sessionIds: useMemo(() => new Set(query.data ?? []), [query.data]),
        isLoading: queryEnabled && query.isLoading,
        error: queryEnabled && query.error
            ? query.error instanceof Error ? query.error.message : 'Failed to load scratchlist status'
            : null,
    }
}
