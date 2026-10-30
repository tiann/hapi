import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { KimiModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useKimiModelsForCwd(args: {
    api: ApiClient | null
    machineId?: string | null
    cwd?: string | null
    enabled?: boolean
}): {
    availableModels: KimiModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
} {
    const { api, machineId, cwd } = args
    const trimmedCwd = typeof cwd === 'string' ? cwd.trim() : ''
    const enabled = Boolean(args.enabled && api && machineId && trimmedCwd)

    const query = useQuery({
        queryKey: machineId && trimmedCwd
            ? queryKeys.machineKimiModelsForCwd(machineId, trimmedCwd)
            : ['machine-kimi-models', 'unknown', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !machineId || !trimmedCwd) {
                throw new Error('Kimi models target unavailable')
            }
            return await api.getMachineKimiModelsForCwd(machineId, trimmedCwd)
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
            ? (query.data.error ?? 'Failed to load Kimi models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Kimi models'
                    : null,
    }
}
