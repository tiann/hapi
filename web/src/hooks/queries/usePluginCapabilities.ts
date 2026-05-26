import { useQuery } from '@tanstack/react-query'
import type { ApiClient, PluginCapabilitiesQuery } from '@/api/client'
import type { PluginCapabilityView } from '@hapi/protocol/plugins/admin'
import { queryKeys } from '@/lib/query-keys'

export function usePluginCapabilities(api: ApiClient | null, options?: PluginCapabilitiesQuery): {
    capabilities: PluginCapabilityView[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.pluginCapabilities(options),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getPluginCapabilities(options)
        },
        enabled: Boolean(api),
    })

    return {
        capabilities: query.data?.capabilities ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load plugin capabilities' : null,
        refetch: query.refetch,
    }
}
