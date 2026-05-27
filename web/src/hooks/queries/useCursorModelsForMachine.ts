import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CursorModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCursorModelsForMachine(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): {
    availableModels: CursorModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
    refetch: () => void
} {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)

    const query = useQuery({
        queryKey: machineId
            ? queryKeys.machineCursorModels(machineId)
            : ['machine-cursor-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!machineId) {
                throw new Error('Cursor models target unavailable')
            }
            return await api.getMachineCursorModels(machineId)
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
            ? (query.data.error ?? 'Failed to load Cursor models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Cursor models'
                    : null,
        refetch: () => {
            void query.refetch()
        }
    }
}
