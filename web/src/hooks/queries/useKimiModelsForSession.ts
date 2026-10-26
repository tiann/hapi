import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { KimiModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useKimiModelsForSession(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: KimiModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionKimiModels(args.sessionId)
            : ['session-kimi-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Kimi session unavailable')
            return await args.api.getSessionKimiModels(args.sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Kimi models')
            : query.error instanceof Error ? query.error.message : null,
    }
}
