import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ClaudeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useClaudeModelsForCwd(args: {
    api: ApiClient | null
    machineId?: string | null
    cwd?: string | null
    enabled?: boolean
}): {
    availableModels: ClaudeModelSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => void
} {
    const { api, machineId, cwd } = args
    const trimmedCwd = typeof cwd === 'string' ? cwd.trim() : ''
    const enabled = Boolean(args.enabled && api && machineId && trimmedCwd)

    const query = useQuery({
        queryKey: machineId && trimmedCwd
            ? queryKeys.machineClaudeModelsForCwd(machineId, trimmedCwd)
            : ['machine-claude-models', 'unknown', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!machineId || !trimmedCwd) {
                throw new Error('Claude models target unavailable')
            }
            return await api.getMachineClaudeModelsForCwd(machineId, trimmedCwd)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        availableModels: query.data?.models ?? [],
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Claude models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Claude models'
                    : null,
        refetch: () => {
            void query.refetch()
        }
    }
}
