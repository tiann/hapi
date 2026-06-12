import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function isSessionNotFoundError(error: unknown): boolean {
    return error instanceof Error
        && (error.message.includes('HTTP 404') || error.message.includes('Session not found'))
}

// Session detail freshness is driven by SSE events (`useSSE` patches the cache
// directly on `session-updated`).  The REST endpoint is only a cold-start /
// reconnect-recovery path, so a long staleTime cuts focus-refetch and
// remount-refetch storms without making the UI stale.  See tiann/hapi#884.
export const SESSION_DETAIL_STALE_TIME_MS = 30_000

export function useSession(api: ApiClient | null, sessionId: string | null): {
    session: Session | null
    isLoading: boolean
    error: string | null
    notFound: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSession(sessionId)
        },
        enabled: Boolean(api && sessionId),
        staleTime: SESSION_DETAIL_STALE_TIME_MS,
        retry: (failureCount, error) => {
            if (isSessionNotFoundError(error)) {
                return false
            }
            return failureCount < 2
        },
    })

    return {
        session: query.data?.session ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        notFound: isSessionNotFoundError(query.error) && !query.isFetching,
        refetch: query.refetch,
    }
}
