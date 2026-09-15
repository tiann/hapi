import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { GrokModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useGrokModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: GrokModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionGrokModels(args.sessionId)
            : ['session-grok-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Grok session unavailable')
            return await args.api.getSessionGrokModels(args.sessionId)
        },
        enabled,
        // The session-side handler probes grok's live catalog: poll so an
        // already-open picker tracks config changes (staleTime alone never
        // refetches while mounted).
        staleTime: 30_000,
        refetchInterval: enabled ? 15_000 : false,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Grok models')
            : query.error instanceof Error ? query.error.message : null,
    }
}
