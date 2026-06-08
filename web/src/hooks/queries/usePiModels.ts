import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PiModelSummary, PiModelsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function usePiModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: PiModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionPiModels(sessionId)
            : ['session-pi-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('Pi models target unavailable')
            }
            return await api.callPiEndpoint<PiModelsResponse>(sessionId, 'models')
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Pi models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Pi models'
                    : null,
    }
}
