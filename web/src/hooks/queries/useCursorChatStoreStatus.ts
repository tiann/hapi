import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CursorChatStoreStatus, Session, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type CursorChatStoreSession = Pick<Session | SessionSummary, 'id' | 'active' | 'metadata'>

export function useCursorChatStoreStatus(args: {
    api: ApiClient | null
    session: CursorChatStoreSession | null
    enabled?: boolean
}): {
    status: CursorChatStoreStatus | undefined
    isApplicable: boolean
    isLoading: boolean
    error: string | null
} {
    const { api, session } = args
    const metadata = session?.metadata
    const cursorSessionId = metadata && 'cursorSessionId' in metadata
        ? metadata.cursorSessionId
        : metadata && 'agentSessionId' in metadata
            ? metadata.agentSessionId
            : undefined
    const shouldProbe = Boolean(
        session
        && !session.active
        && metadata?.flavor === 'cursor'
        && cursorSessionId
        && metadata.path
    )
    const enabled = Boolean((args.enabled ?? true) && api && shouldProbe)
    const sessionId = session?.id ?? 'unknown'

    const query = useQuery({
        queryKey: queryKeys.sessionCursorChatStore(sessionId),
        queryFn: async () => {
            if (!api || !session) {
                throw new Error('Cursor session unavailable')
            }
            return await api.getCursorChatStoreStatus(session.id)
        },
        enabled,
        staleTime: 5_000,
        retry: false,
    })

    return {
        status: query.data,
        isApplicable: shouldProbe,
        isLoading: query.isLoading,
        error: query.error instanceof Error
            ? query.error.message
            : query.error
                ? 'Failed to inspect Cursor chat store'
                : null,
    }
}
