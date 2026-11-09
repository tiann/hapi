import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { GrokReasoningEffortOption } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * Thinking levels Kimi's ACP `thought_level` option offers for the active
 * model. Keyed by model so a switch hides the previous model's levels; the CLI
 * answers `success: false` until the backend is ready and the switch has been
 * applied (next turn), so poll until it succeeds.
 */
export function useKimiReasoningEffortOptions(args: {
    api: ApiClient | null
    sessionId: string
    model: string | null | undefined
    enabled: boolean
}): GrokReasoningEffortOption[] {
    const query = useQuery({
        queryKey: queryKeys.sessionKimiReasoningEffortOptions(args.sessionId, args.model ?? null),
        queryFn: async () => {
            if (!args.api) throw new Error('Kimi session unavailable')
            return await args.api.getSessionKimiReasoningEffortOptions(args.sessionId)
        },
        enabled: Boolean(args.enabled && args.api),
        staleTime: 30_000,
        retry: 3,
        refetchInterval: (query) => (query.state.data?.success === true ? false : 5_000),
    })
    return query.data?.success ? query.data.options ?? [] : []
}
