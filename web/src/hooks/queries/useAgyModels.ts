import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { AgyModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useAgyModels(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): {
    availableModels: AgyModelSummary[]
    currentModelId: string | null
    isLoading: boolean
    error: string | null
    /**
     * The machine still has a catalog but its last sign-in check failed, so the
     * list is usable and out of date at the same time. Separate from `error`,
     * which means there is nothing to show.
     */
    warning: string | null
    /** A request is in flight, including a Retry over an already-loaded catalog. */
    isFetching: boolean
    refetch: () => void
} {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)
    // Spent on the very next fetch so mount and focus refetches stay answerable
    // from the machine's cache; only Retry means that cache is not wanted.
    const forceRefreshRef = useRef(false)

    const query = useQuery({
        queryKey: machineId
            ? queryKeys.machineAgyModels(machineId)
            : ['machine-agy-models', 'unknown'] as const,
        queryFn: async () => {
            const refresh = forceRefreshRef.current
            forceRefreshRef.current = false
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!machineId) {
                throw new Error('Agy models target unavailable')
            }
            return await api.getMachineAgyModels(machineId, { refresh })
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Agy models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Agy models'
                    : null,
        warning: query.data?.success === true ? (query.data.error ?? null) : null,
        isFetching: query.isFetching,
        refetch: () => {
            forceRefreshRef.current = true
            void query.refetch()
        }
    }
}
