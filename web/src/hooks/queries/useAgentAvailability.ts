import { useQuery } from '@tanstack/react-query'
import type { AgentAvailabilityEntry } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useAgentAvailability(args: {
    api: ApiClient | null
    machineId: string | null
    enabled?: boolean
}): {
    agents: AgentAvailabilityEntry[]
    isLoading: boolean
    error: string | null
    upgradeRequired: boolean
    refetch: () => void
} {
    const enabled = Boolean((args.enabled ?? true) && args.api && args.machineId)
    const query = useQuery({
        queryKey: queryKeys.machineAgentAvailability(args.machineId ?? 'unknown'),
        queryFn: async () => {
            if (!args.api || !args.machineId) throw new Error('Agent availability target unavailable')
            return await args.api.getMachineAgentAvailability(args.machineId)
        },
        enabled,
        staleTime: 30_000,
        retry: false,
    })
    const upgradeRequired = query.error instanceof ApiError
        && query.error.code === 'runner_upgrade_required'

    return {
        agents: query.data?.agents ?? [],
        isLoading: enabled && query.isLoading,
        error: query.error instanceof Error
            ? query.error.message
            : query.error
                ? 'Failed to inspect Agent availability'
                : null,
        upgradeRequired,
        refetch: () => {
            void query.refetch()
        },
    }
}
