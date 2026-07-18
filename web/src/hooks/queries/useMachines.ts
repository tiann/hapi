import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function calculateServerTimeOffset(
    serverTime: number | undefined,
    requestStartedAt: number,
    responseReceivedAt: number
): number {
    if (serverTime === undefined || !Number.isFinite(serverTime)) {
        return 0
    }
    const responseLatency = Math.max(responseReceivedAt - requestStartedAt, 0)
    const estimatedLocalTimeAtServerResponse = requestStartedAt + responseLatency / 2
    return serverTime - estimatedLocalTimeAtServerResponse
}

export function useMachines(api: ApiClient | null, enabled: boolean): {
    machines: Machine[]
    knownMachinesCount: number
    offlineMachinesCount: number
    serverTimeOffsetMs: number
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.machines,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const requestStartedAt = Date.now()
            const response = await api.getMachines()
            const responseReceivedAt = Date.now()
            return {
                ...response,
                serverTimeOffsetMs: calculateServerTimeOffset(
                    response.serverTime,
                    requestStartedAt,
                    responseReceivedAt
                )
            }
        },
        enabled: Boolean(api && enabled),
    })

    return {
        machines: query.data?.machines ?? [],
        knownMachinesCount: query.data?.knownMachinesCount ?? query.data?.machines.length ?? 0,
        offlineMachinesCount: query.data?.offlineMachinesCount ?? 0,
        serverTimeOffsetMs: query.data?.serverTimeOffsetMs ?? 0,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load machines' : null,
        refetch: query.refetch,
    }
}
