import { mergeReadState } from '@hapi/protocol'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { sessionSeedFromSummary } from '@/lib/sessionSeed'

export function isSessionNotFoundError(error: unknown): boolean {
    return error instanceof Error
        && (error.message.includes('HTTP 404') || error.message.includes('Session not found'))
}

// Session detail freshness is driven by SSE events (`useSSE` patches the cache
// directly on `session-updated`).  The REST endpoint is only a cold-start /
// reconnect-recovery path, so a long per-query staleTime extends the global
// default (5s, see `web/src/lib/query-client.ts`) for `useSession` only — this
// suppresses remount-refetch when the user navigates back to a recently-viewed
// session within the window, without making the UI stale.  Explicit
// `invalidateQueries` calls (SSE fallback path, reconnect-recovery in
// `App.tsx`) still refetch active observers regardless of staleTime, so live
// updates and recovery flows continue to work.  See tiann/hapi#884.
export const SESSION_DETAIL_STALE_TIME_MS = 30_000

export function useSession(api: ApiClient | null, sessionId: string | null): {
    session: Session | null
    isLoading: boolean
    error: string | null
    notFound: boolean
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const resolvedSessionId = sessionId ?? 'unknown'
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        // Zero-RTT first open: when the sessions list cache already holds a
        // (slim) row for this id, seed the detail cache from it so SessionChat
        // renders immediately instead of gating first paint on the detail GET
        // (~350-450ms on high-RTT links). `initialDataUpdatedAt: 0` marks the
        // seed infinitely stale, so the real GET still fires on mount and
        // react-query overwrites the seed when it lands; SSE patches keep
        // flowing during the window (the seed carries the version watermarks
        // the patch gates compare against). Deep links to ids that are not in
        // the list get no seed and keep the old loading gate.
        initialData: () => {
            if (!api || !sessionId) {
                return undefined
            }
            const row = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
                ?.sessions.find(summary => summary.id === sessionId)
            return row ? { session: sessionSeedFromSummary(row) } : undefined
        },
        initialDataUpdatedAt: 0,
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const response = await api.getSession(sessionId)
            const current = queryClient.getQueryData<{ session: Session }>(queryKeys.session(sessionId))?.session
            return { ...response, session: { ...response.session,
                contentRevision: Math.max(current?.contentRevision ?? 0, response.session.contentRevision ?? 0),
                readState: mergeReadState(current?.readState, response.session.readState)
            } }
        },
        enabled: Boolean(api && sessionId),
        staleTime: SESSION_DETAIL_STALE_TIME_MS,
        retry: (failureCount, error) => {
            if (isSessionNotFoundError(error)) {
                return false
            }
            return failureCount < 2
        },
    })

    return {
        session: query.data?.session ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        notFound: isSessionNotFoundError(query.error) && !query.isFetching,
        refetch: query.refetch,
    }
}
