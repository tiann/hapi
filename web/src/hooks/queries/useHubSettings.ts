import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { HubSettingsResponse } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'

/** Hub settings shared by operator UI surfaces; missing peer-tools data stays enabled for old Hubs. */
export function useHubSettings(api: ApiClient | null): {
    data: HubSettingsResponse | undefined
    peerToolsEnabled: boolean
} {
    const query = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getHubSettings()
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        retry: false,
    })

    return {
        data: query.data,
        peerToolsEnabled: query.data?.peerToolsEnabled ?? true,
    }
}
