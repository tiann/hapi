import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionReasoningEffortOption, SessionReasoningEffortResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function shouldRetrySessionReasoningEffortQuery(failureCount: number): boolean {
    return failureCount < 3
}

export function getSessionReasoningEffortRefetchInterval(
    enabled: boolean,
    data: SessionReasoningEffortResponse | undefined,
    pollCount: number
): number | false {
    if (!enabled || data?.success === true) {
        return false
    }
    return 1000 * 2 ** Math.min(pollCount, 3)
}

export function selectSessionReasoningEffortResponse(
    response: SessionReasoningEffortResponse,
    model?: string | null
): SessionReasoningEffortResponse {
    if (response.success && response.model !== (model ?? null)) {
        return {
            success: false,
            error: 'Session model is still switching'
        }
    }
    return response
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
            const response = await args.api.getSessionReasoningEffortOptions(args.sessionId)
            return selectSessionReasoningEffortResponse(response, args.model)
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
