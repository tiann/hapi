import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { HermesModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export interface HermesModelsState {
    availableModels: HermesModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
}

/** Machine-scoped Hermes catalog for the new-session form (probes `hermes acp`). */
export function useHermesModelsForMachine(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): HermesModelsState {
    const enabled = Boolean(args.enabled && args.api && args.machineId)
    const query = useQuery({
        queryKey: args.machineId
            ? queryKeys.machineHermesModels(args.machineId)
            : ['machine-hermes-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.machineId) throw new Error('Hermes models target unavailable')
            return await args.api.getMachineHermesModels(args.machineId)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Hermes models')
            : query.error instanceof Error ? query.error.message : null,
    }
}

/** Live session catalog for the in-chat model switcher (reads the running Hermes ACP session). */
export function useHermesModelsForSession(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): HermesModelsState {
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
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Hermes models')
            : query.error instanceof Error ? query.error.message : null,
    }
}
