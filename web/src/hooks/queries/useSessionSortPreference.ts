import { useQuery } from '@tanstack/react-query'

import type { ApiClient } from '@/api/client'
import type { SessionSortPreference } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const DEFAULT_SORT_PREFERENCE: SessionSortPreference = {
    sortMode: 'auto',
    manualOrder: {
        groupOrder: [],
        sessionOrder: {}
    },
    version: 1,
    updatedAt: 0
}

export function useSessionSortPreference(api: ApiClient | null): {
    preference: SessionSortPreference
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.sessionSortPreference,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }

            return await api.getSessionSortPreference()
        },
        enabled: Boolean(api)
    })

    return {
        preference: query.data?.preference ?? DEFAULT_SORT_PREFERENCE,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session sort preference' : null,
        refetch: query.refetch
    }
}
