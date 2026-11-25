import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { OpencodeModelVariantsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useOpencodeModelVariants(args: {
    api: ApiClient | null
    machineId?: string | null
    /** Requesting directory — the variant catalog respects project-level opencode config, so only same-cwd servers are reused. */
    cwd?: string | null
    enabled?: boolean
}): {
    variants: Record<string, string[]> | null
    isLoading: boolean
    error: string | null
} {
    const { api, machineId, cwd } = args
    const enabled = Boolean(args.enabled && api && machineId)

    const query = useQuery({
        queryKey: [...queryKeys.machineOpencodeModelVariants(machineId ?? 'unknown'), cwd ?? null],
        queryFn: async (): Promise<OpencodeModelVariantsResponse> => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!machineId) {
                throw new Error('OpenCode model variants target unavailable')
            }
            return await api.getMachineOpencodeModelVariants(machineId, cwd)
        },
        enabled,
        staleTime: 5 * 60_000,
        retry: false,
    })

    return {
        variants: query.data?.success && query.data.variants ? query.data.variants : null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load OpenCode model variants')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load OpenCode model variants'
                    : null,
    }
}
