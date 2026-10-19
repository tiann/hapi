import { useQuery } from '@tanstack/react-query'
import type { OpencodeModelsResponse } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import type { OpencodeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function shouldRetryOpencodeModelsQuery(failureCount: number): boolean {
    return failureCount < 3
}

const MAX_OPENCODE_MODEL_DISCOVERY_POLLS = 10

export function getOpencodeModelsRefetchInterval(
    enabled: boolean,
    data: OpencodeModelsResponse | undefined,
    pollCount: number
): 1000 | 15_000 | false {
    if (!enabled) {
        return false
    }
    // Discovered a non-empty catalog: track opencode.json changes at a slower
    // cadence — staleTime alone never triggers a refetch while mounted.
    if (data?.success && (data.availableModels?.length ?? 0) > 0) {
        return 15_000
    }
    // Missing/error/empty responses are "still discovering": poll fast until
    // the discovery cap, then settle on the slow tracking cadence instead of
    // hammering the RPC forever (a catalog may legitimately stay empty).
    return pollCount >= MAX_OPENCODE_MODEL_DISCOVERY_POLLS ? 15_000 : 1000
}

export function useOpencodeModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: OpencodeModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionOpencodeModels(sessionId)
            : ['session-opencode-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('OpenCode models target unavailable')
            }
            return await api.getSessionOpencodeModels(sessionId)
        },
        enabled,
        // Track opencode.json changes quickly (same rationale as usePiModels).
        staleTime: 15_000,
        retry: (failureCount) => shouldRetryOpencodeModelsQuery(failureCount),
        refetchInterval: (query) => getOpencodeModelsRefetchInterval(
            enabled,
            query.state.data as OpencodeModelsResponse | undefined,
            query.state.dataUpdateCount + query.state.errorUpdateCount
        ),
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load OpenCode models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load OpenCode models'
                    : null,
    }
}
