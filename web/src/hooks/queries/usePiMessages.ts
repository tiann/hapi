import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PiMessagesResponse } from '@/types/api'
import type { PiMessageEntry } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'

export function usePiMessages(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    messages: PiMessageEntry[]
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionPiMessages(sessionId)
            : ['session-pi-messages', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('Pi messages target unavailable')
            }
            return await api.callPiEndpoint<PiMessagesResponse>(sessionId, 'messages')
        },
        enabled,
        staleTime: 30_000,
        retry: false,
    })

    return {
        messages: query.data?.messages ?? [],
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Pi messages')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Pi messages'
                    : null,
    }
}
