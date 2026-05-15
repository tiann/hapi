import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { OpencodeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

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
        staleTime: 30_000,
        retry: false,
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
