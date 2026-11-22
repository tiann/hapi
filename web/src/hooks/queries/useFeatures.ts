import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PrChipDisplayProfile } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'

export type FeaturesResponse = {
    githubPrAwareness: {
        enabled: boolean
        source: 'env' | 'file' | 'default'
    }
    prChipDisplay: PrChipDisplayProfile
}

export function useFeatures(api: ApiClient | null): {
    features: FeaturesResponse | null
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.features,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getFeatures()
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        refetchInterval: 30_000,
        refetchIntervalInBackground: false
    })

    return {
        features: query.data ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load features' : null,
        refetch: query.refetch
    }
}

export function usePatchFeatures(api: ApiClient | null): {
    setGithubPrAwareness: (enabled: boolean) => Promise<FeaturesResponse>
    isPending: boolean
} {
    const queryClient = useQueryClient()
    const mutation = useMutation({
        mutationFn: async (enabled: boolean) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.patchFeatures({ githubPrAwareness: enabled })
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.features, data)
        }
    })

    return {
        setGithubPrAwareness: mutation.mutateAsync,
        isPending: mutation.isPending
    }
}
