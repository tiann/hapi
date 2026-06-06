import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CursorModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCursorModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: CursorModelSummary[]
    cliModelSkus: CursorModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionCursorModels(sessionId)
            : ['session-cursor-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('Cursor models target unavailable')
            }
            return await api.getSessionCursorModels(sessionId)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        cliModelSkus: query.data?.cliModelSkus ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Cursor models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Cursor models'
                    : null,
    }
}
