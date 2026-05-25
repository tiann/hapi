import { useQuery } from '@tanstack/react-query'
import type { ApiClient, PluginMarketplaceQuery } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import type { PluginMarketplaceEntryView } from '@hapi/protocol/plugins/marketplace'

export function usePluginMarketplace(api: ApiClient | null, query?: PluginMarketplaceQuery): {
    entries: PluginMarketplaceEntryView[]
    sourceUrl: string | null
    fetchedAt: number | null
    isLoading: boolean
    isFetching: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const normalized = {
        q: query?.q?.trim() || undefined,
        category: query?.category || undefined,
        runtime: query?.runtime || undefined
    }
    const result = useQuery({
        queryKey: queryKeys.pluginMarketplace(normalized),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getPluginMarketplace(normalized)
        },
        enabled: Boolean(api),
    })

    return {
        entries: result.data?.entries ?? [],
        sourceUrl: result.data?.sourceUrl ?? null,
        fetchedAt: result.data?.fetchedAt ?? null,
        isLoading: result.isLoading,
        isFetching: result.isFetching,
        error: result.error instanceof Error ? result.error.message : result.error ? 'Failed to load marketplace' : null,
        refetch: result.refetch,
    }
}
