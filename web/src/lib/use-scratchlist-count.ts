import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

/**
 * tiann/hapi#893: read-only count of scratchlist entries for a session.
 *
 * Reuses the same TanStack Query cache key as `useHubScratchlist`, so
 * the cost of calling it here in `SessionHeader` is zero when the same
 * session is rendered in `SessionChat` - both components share one
 * fetch.
 *
 * Used by the delete-session confirmation dialog to surface
 * "this will also delete N scratchlist entries" copy. The signal is the
 * count, not the entries themselves; we deliberately do not list them
 * inline because the list could be long and would compete with the
 * confirm action for attention.
 */
export function useScratchlistCount(sessionId: string, api: ApiClient | null): number {
    const query = useQuery<{ entries: Array<unknown> }>({
        queryKey: queryKeys.scratchlist(sessionId),
        queryFn: async () => {
            if (!api) return { entries: [] }
            return await api.getScratchlist(sessionId)
        },
        enabled: Boolean(api && sessionId),
        staleTime: 30_000,
    })
    return query.data?.entries.length ?? 0
}
