import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session, SessionResponse, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionResponse, needsSessionResponseRetry } from '@/lib/sessionCache'

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
    const resolvedSessionId = sessionId ?? 'unknown'
    const queryClient = useQueryClient()
    // Subscribe to the list cache so a newer reply-clock watermark triggers
    // the detail recovery path even when the detail query itself is fresh.
    const sessionsQuery = useQuery<SessionsResponse>({
        queryKey: queryKeys.sessions,
        queryFn: async () => queryClient.getQueryData<SessionsResponse>(queryKeys.sessions) ?? { sessions: [] },
        enabled: false,
        staleTime: Infinity,
    })
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            let incoming = await api.getSession(sessionId)
            let current = queryClient.getQueryData<SessionResponse>(queryKeys.session(resolvedSessionId))
            let currentSummary = sessionsQuery.data
                ?.sessions.find((summary) => summary.id === sessionId)
            if (needsSessionResponseRetry(current, incoming, currentSummary)) {
                // A newer SSE patch may only carry the reply clock. Retry once
                // so unrelated fields from the discarded REST snapshot are
                // not left stale indefinitely on an otherwise quiet session.
                incoming = await api.getSession(sessionId)
                current = queryClient.getQueryData<SessionResponse>(queryKeys.session(resolvedSessionId)) ?? current
                currentSummary = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
                    ?.sessions.find((summary) => summary.id === sessionId) ?? currentSummary
                const listWatermark = currentSummary?.lastAssistantMessageVersion ?? 0
                const cachedDetailVersion = current?.session?.seq ?? 0
                if (
                    cachedDetailVersion < listWatermark
                    && incoming.session.seq < listWatermark
                ) {
                    throw new Error('Session detail response is older than the cached session list')
                }
            }
            return mergeSessionResponse(current, incoming, currentSummary)
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

    const cachedSummary = sessionsQuery.data
        ?.sessions.find((summary) => summary.id === sessionId)
    const cachedSession = query.data?.session
    const listWatermark = cachedSummary?.lastAssistantMessageVersion ?? 0
    const isBelowListWatermark = Boolean(
        cachedSession
        && cachedSession.seq < listWatermark
    )
    const refreshAttemptedForWatermark = useRef<string | null>(null)
    const refreshKey = `${sessionId ?? ''}:${listWatermark}`
    useEffect(() => {
        if (!isBelowListWatermark || query.isFetching || refreshAttemptedForWatermark.current === refreshKey) {
            return
        }
        refreshAttemptedForWatermark.current = refreshKey
        void query.refetch()
    }, [isBelowListWatermark, query.isFetching, query.refetch, refreshKey])
    return {
        session: isBelowListWatermark ? null : cachedSession ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        notFound: isSessionNotFoundError(query.error) && !query.isFetching,
        refetch: query.refetch,
    }
}
