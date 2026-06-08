import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PiForkMessageEntry } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'

export function usePiForkMessages(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    messages: PiForkMessageEntry[]
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionPiForkMessages(sessionId)
            : ['session-pi-fork-messages', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('Pi fork messages target unavailable')
            }
            return await api.getPiForkMessages(sessionId)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        messages: query.data?.messages ?? [],
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Pi fork messages')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Pi fork messages'
                    : null,
    }
}
