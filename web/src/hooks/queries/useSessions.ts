import { useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { compareSessionSummaries } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { reconcileDelayedListSession } from '@/lib/sessionPatch'
import { reconcileAttachedJobsFromCache } from './reconcileAttachedJobs'

export type UseSessionsOptions = {
    enabled?: boolean
}

export function useSessions(api: ApiClient | null, options: UseSessionsOptions = {}): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    // Last `hubGeneration` this tab has observed. A DIFFERENT value on the
    // next response means a different hub process produced it — every
    // cached `thinkingRevision` this tab holds describes a process that no
    // longer exists, not just whatever session a 0 happened to catch
    // (#1717 cold-review round 29). `undefined` on the very first response
    // deliberately does not count as a restart: there is no prior cache yet
    // for a stale revision to protect.
    const lastHubGenerationRef = useRef<string | undefined>(undefined)
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const response = await api.getSessions()
            // SSE may have delivered newer input while this GET was in flight.
            // Retain its monotonic ordering clock, not deleted rows or stale data.
            const current = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            const cached = new Map(current?.sessions.map(s => [s.id, s]))
            const hubRestarted = lastHubGenerationRef.current !== undefined
                && response.hubGeneration !== undefined
                && lastHubGenerationRef.current !== response.hubGeneration
            lastHubGenerationRef.current = response.hubGeneration
            const withClocks: SessionsResponse = {
                ...response,
                sessions: response.sessions
                    .map(session => reconcileDelayedListSession(cached.get(session.id), session, hubRestarted))
                    .sort(compareSessionSummaries)
            }
            return reconcileAttachedJobsFromCache(withClocks, current)
        },
        enabled: Boolean(api) && (options.enabled ?? true),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
