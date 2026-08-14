import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DshModelsResponse } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'

export function useDshModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    models: DshModelsResponse | null
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionDshModels(sessionId)
            : ['session-dsh-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('DSH models target unavailable')
            }
            return await api.dshModels(sessionId)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        models: query.data ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : (query.error ?? null),
        refetch: query.refetch,
    }
}
