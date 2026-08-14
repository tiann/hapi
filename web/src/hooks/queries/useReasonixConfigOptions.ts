import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ReasonixConfigOption, ReasonixModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useReasonixConfigOptions(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: ReasonixModelSummary[]
    currentModelId: string | null
    effortOptions: ReasonixConfigOption[]
    isLoading: boolean
    error: string | null
} {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionReasonixConfigOptions(args.sessionId)
            : ['session-reasonix-config-options', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Reasonix session unavailable')
            return await args.api.getSessionReasonixConfigOptions(args.sessionId)
        },
        enabled,
        staleTime: 5_000,
        // Reasonix can replace its model/effort catalog after a native mode or
        // preset change. Keep the composer in sync while the session is open;
        // background tabs can refresh when they become visible again.
        refetchInterval: enabled ? 5_000 : false,
        refetchIntervalInBackground: false,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        effortOptions: query.data?.effortOptions ?? [],
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Reasonix config options')
            : query.error instanceof Error ? query.error.message : null,
    }
}
