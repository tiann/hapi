import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { GrokReasoningEffortOption } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useGrokReasoningEffortOptions(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    options: GrokReasoningEffortOption[]
    currentValue: string | null
    isLoading: boolean
    error: string | null
} {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionGrokReasoningEffortOptions(args.sessionId)
            : ['session-grok-reasoning-effort-options', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Grok session unavailable')
            return await args.api.getSessionGrokReasoningEffortOptions(args.sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: false,
    })

    return {
        options: query.data?.options ?? [],
        currentValue: query.data?.currentValue ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Grok effort options')
            : query.error instanceof Error ? query.error.message : null,
    }
}
