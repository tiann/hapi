import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { GrokReasoningEffortOption } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/** Effort levels Copilot's ACP `thought_level` option offers for the active model. */
export function useCopilotReasoningEffortOptions(args: {
    api: ApiClient | null
    sessionId: string
    enabled: boolean
}): GrokReasoningEffortOption[] {
    const query = useQuery({
        queryKey: queryKeys.sessionCopilotReasoningEffortOptions(args.sessionId),
        queryFn: async () => {
            if (!args.api) throw new Error('Copilot session unavailable')
            return await args.api.getSessionCopilotReasoningEffortOptions(args.sessionId)
        },
        enabled: Boolean(args.enabled && args.api),
        staleTime: 30_000,
        retry: false,
    })
    return query.data?.options ?? []
}
