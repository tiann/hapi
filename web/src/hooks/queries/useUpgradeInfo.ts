import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FleetUpgradePolicy } from '@hapi/protocol/upgradeChannel'
import type { ApiClient, UpgradeInfoResponse } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

/**
 * Hub upgrade offer + fleet-upgrade policy (the 3-pole switch). Drives both the
 * skew banner (offer for drift detection, policy for visibility) and the
 * Settings switch.
 */
export function useUpgradeInfo(api: ApiClient | null, enabled = true): {
    info: UpgradeInfoResponse | null
    isLoading: boolean
} {
    const query = useQuery({
        queryKey: queryKeys.upgradeInfo,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getUpgradeInfo()
        },
        enabled: Boolean(api && enabled),
        staleTime: 30_000,
    })
    return { info: query.data ?? null, isLoading: query.isLoading }
}

export function useSetFleetUpgradePolicy(api: ApiClient | null) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (policy: FleetUpgradePolicy) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.setFleetUpgradePolicy(policy)
        },
        onMutate: async (policy) => {
            await queryClient.cancelQueries({ queryKey: queryKeys.upgradeInfo })
            const previous = queryClient.getQueryData<UpgradeInfoResponse>(queryKeys.upgradeInfo)
            if (previous) {
                queryClient.setQueryData<UpgradeInfoResponse>(queryKeys.upgradeInfo, { ...previous, policy })
            }
            return { previous }
        },
        onError: (_error, _policy, context) => {
            if (context?.previous) {
                queryClient.setQueryData(queryKeys.upgradeInfo, context.previous)
            }
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.upgradeInfo })
        },
    })
}
