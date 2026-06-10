import { useQuery } from '@tanstack/react-query'
import type { OpencodeReasoningEffortResponse } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function shouldRetryOpencodeReasoningEffortQuery(failureCount: number): boolean {
    return failureCount < 3
}

const MAX_OPENCODE_REASONING_EFFORT_DISCOVERY_POLLS = 10

export function getOpencodeReasoningEffortRefetchInterval(
    enabled: boolean,
    data: OpencodeReasoningEffortResponse | undefined,
    pollCount: number
): 1000 | false {
    if (!enabled || pollCount >= MAX_OPENCODE_REASONING_EFFORT_DISCOVERY_POLLS) {
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

export function useOpencodeReasoningEffortOptions(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    options: Array<{ value: string; name?: string }>
    currentValue: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionOpencodeReasoningEffortOptions(sessionId)
            : ['session-opencode-reasoning-effort-options', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('OpenCode reasoning effort target unavailable')
            }
            return await api.getSessionOpencodeReasoningEffortOptions(sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: (failureCount) => shouldRetryOpencodeReasoningEffortQuery(failureCount),
        refetchInterval: (query) => getOpencodeReasoningEffortRefetchInterval(
            enabled,
            query.state.data as OpencodeReasoningEffortResponse | undefined,
            query.state.dataUpdateCount + query.state.errorUpdateCount
        ),
    })

    return {
        options: query.data?.options ?? [],
        currentValue: query.data?.currentValue ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load OpenCode reasoning effort options')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load OpenCode reasoning effort options'
                    : null,
    }
}
