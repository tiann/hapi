import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { GrokReasoningEffortOption } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/** Thinking levels Kimi's ACP `thought_level` option offers for the active model. */
export function useKimiReasoningEffortOptions(args: {
    api: ApiClient | null
    sessionId: string
    enabled: boolean
}): GrokReasoningEffortOption[] {
    const query = useQuery({
        queryKey: queryKeys.sessionKimiReasoningEffortOptions(args.sessionId),
        queryFn: async () => {
            if (!args.api) throw new Error('Kimi session unavailable')
            return await args.api.getSessionKimiReasoningEffortOptions(args.sessionId)
        },
        enabled: Boolean(args.enabled && args.api),
        staleTime: 30_000,
        retry: false,
    })
    return query.data?.options ?? []
}
