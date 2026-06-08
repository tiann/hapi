import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PiSessionStats } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'

export function usePiSessionStats(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    stats: PiSessionStats | null
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionPiStats(sessionId)
            : ['session-pi-stats', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('Pi session stats target unavailable')
            }
            return await api.getPiSessionStats(sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: false,
    })

    return {
        stats: query.data?.stats ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Pi session stats')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Pi session stats'
                    : null,
    }
}
