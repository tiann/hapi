import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CopilotModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCopilotModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: CopilotModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionCopilotModels(args.sessionId)
            : ['session-copilot-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Copilot session unavailable')
            return await args.api.getSessionCopilotModels(args.sessionId)
        },
        enabled,
        // The session-side handler probes the live Copilot catalog: poll so an
        // already-open picker tracks subscription changes (same as useGrokModels).
        staleTime: 30_000,
        refetchInterval: enabled ? 15_000 : false,
        retry: 1,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Copilot models')
            : query.error instanceof Error ? query.error.message : null,
    }
}
