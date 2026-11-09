import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { AcpCatalogModelSummary, BerryModelsResponse, HermesModelsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export interface AcpSessionModelsState {
    availableModels: AcpCatalogModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
}

/** Shared projection for the hermes/berry session model queries (DSH shape). */
function toState(
    data: HermesModelsResponse | BerryModelsResponse | undefined,
    error: Error | null
): AcpSessionModelsState {
    return {
        availableModels: data?.availableModels ?? [],
        currentModelId: data?.currentModelId ?? null,
        isLoading: false,
        error: data?.success === false
            ? (data.error ?? 'Failed to load models')
            : error instanceof Error ? error.message : null
    }
}

/** Live Hermes session catalog (ListHermesModels — opaque `provider:model` ids). */
export function useHermesModelsForSession(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): AcpSessionModelsState {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionHermesModels(args.sessionId)
            : ['session-hermes-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Hermes session unavailable')
            return await args.api.getSessionHermesModels(args.sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: false
    })
    return { ...toState(query.data, query.error), isLoading: query.isLoading }
}

/** Live Berry session catalog (ListBerryModels — opaque `provider/model` ids). */
export function useBerryModelsForSession(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): AcpSessionModelsState {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionBerryModels(args.sessionId)
            : ['session-berry-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('Berry session unavailable')
            return await args.api.getSessionBerryModels(args.sessionId)
        },
        enabled,
        staleTime: 30_000,
        retry: false
    })
    return { ...toState(query.data, query.error), isLoading: query.isLoading }
}
