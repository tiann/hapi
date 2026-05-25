import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PluginDetail, PluginTargetScope } from '@hapi/protocol/plugins/admin'
import { queryKeys } from '@/lib/query-keys'

export function usePlugin(api: ApiClient | null, pluginId: string, target?: PluginTargetScope): {
    plugin: PluginDetail | null
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.plugin(pluginId, target),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getPlugin(pluginId, target)
        },
        enabled: Boolean(api && pluginId),
    })

    return {
        plugin: query.data?.plugin ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load plugin' : null,
        refetch: query.refetch,
    }
}
