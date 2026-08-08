import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

type SessionDetailCache = {
    session: {
        id: string
        active: boolean
        [key: string]: unknown
    }
    [key: string]: unknown
}

/**
 * Apply a background getSession response only when the cache still agrees on
 * `active`. If SSE already flipped active/inactive while the request was in
 * flight, keep the newer local transition instead of resurrecting a stale REST
 * snapshot.
 */
export function mergeSessionDetailIfActiveUnchanged(
    current: SessionDetailCache | undefined,
    response: SessionDetailCache,
): SessionDetailCache | undefined {
    if (current?.session.active !== response.session.active) return current
    return response
}

/** Background-refresh session detail without clobbering a newer active flag. */
export function refreshSessionDetailPreservingActive(
    queryClient: QueryClient,
    resolvedSessionId: string,
    fetchDetail: () => Promise<SessionDetailCache>,
): Promise<void> {
    return fetchDetail().then((response) => {
        queryClient.setQueryData(
            queryKeys.session(resolvedSessionId),
            (current: SessionDetailCache | undefined) => (
                mergeSessionDetailIfActiveUnchanged(current, response)
            ),
        )
    }).catch(() => undefined)
}
