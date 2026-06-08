import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PiCommandSummary } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'

export function usePiCommands(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    commands: PiCommandSummary[]
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionPiCommands(sessionId)
            : ['session-pi-commands', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('Pi commands target unavailable')
            }
            return await api.getSessionPiCommands(sessionId)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        commands: query.data?.commands ?? [],
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Pi commands')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Pi commands'
                    : null,
    }
}
