import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DshModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export interface DshModelsState {
    availableModels: DshModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
}

/** Machine-scoped DSH catalog for the new-session form (spawns a probe agent briefly). */
export function useDshModelsForMachine(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): DshModelsState {
    const enabled = Boolean(args.enabled && args.api && args.machineId)
    const query = useQuery({
        queryKey: args.machineId
            ? queryKeys.machineDshModels(args.machineId)
            : ['machine-dsh-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.machineId) throw new Error('DSH models target unavailable')
            return await args.api.getMachineDshModels(args.machineId)
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
            ? (query.data.error ?? 'Failed to load DSH models')
            : query.error instanceof Error ? query.error.message : null,
    }
}

/** Live session catalog for the in-chat model switcher (reads the running agent's config options). */
export function useDshModelsForSession(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): DshModelsState {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionDshModels(args.sessionId)
            : ['session-dsh-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('DSH session unavailable')
            return await args.api.getSessionDshModels(args.sessionId)
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
            ? (query.data.error ?? 'Failed to load DSH models')
            : query.error instanceof Error ? query.error.message : null,
    }
}
