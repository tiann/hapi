import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PiModelSummary, PiModelsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
export function usePiModelsForMachine(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): {
    availableModels: PiModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)

    const query = useQuery({
        queryKey: machineId
            ? queryKeys.machinePiModels(machineId)
            : ['machine-pi-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !machineId) {
                throw new Error('Pi models target unavailable')
            }
            return await api.getMachinePiModels(machineId)
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
            ? (query.data.error ?? 'Failed to load Pi models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Pi models'
                    : null,
    }
}
