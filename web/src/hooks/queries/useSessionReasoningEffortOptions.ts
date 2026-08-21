import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionReasoningEffortOption, SessionReasoningEffortResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function shouldRetrySessionReasoningEffortQuery(failureCount: number): boolean {
    return failureCount < 3
}

const MAX_SESSION_REASONING_EFFORT_DISCOVERY_POLLS = 10

export function getSessionReasoningEffortRefetchInterval(
    enabled: boolean,
    data: SessionReasoningEffortResponse | undefined,
    pollCount: number
): 1000 | false {
    if (!enabled || pollCount >= MAX_SESSION_REASONING_EFFORT_DISCOVERY_POLLS) {
        return false
    }
    if (!data) {
        return 1000
    }
    if (data.success === false) {
        return 1000
    }
    return (data.options?.length ?? 0) > 0 ? false : 1000
}

export function useSessionReasoningEffortOptions(args: {
    api: ApiClient | null
    sessionId?: string | null
    model?: string | null
    enabled?: boolean
}): {
    options: SessionReasoningEffortOption[]
    currentValue: string | null
    isLoading: boolean
    error: string | null
} {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionReasoningEffortOptions(args.sessionId, args.model)
            : ['session-reasoning-effort-options', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Session unavailable')
            return await args.api.getSessionReasoningEffortOptions(args.sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: (failureCount) => shouldRetrySessionReasoningEffortQuery(failureCount),
        refetchInterval: (query) => getSessionReasoningEffortRefetchInterval(
            enabled,
            query.state.data as SessionReasoningEffortResponse | undefined,
            query.state.dataUpdateCount + query.state.errorUpdateCount
        ),
    })

    return {
        options: query.data?.options ?? [],
        currentValue: query.data?.currentValue ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load session effort options')
            : query.error instanceof Error ? query.error.message : null,
    }
}
