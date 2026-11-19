import { useQuery, useQueryClient } from '@tanstack/react-query'
import { compareSessionSummaries, mergeReadState } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { isNewerSessionListEvent, reconcileSessionSchedule, type CachedSessionsResponse } from '@/lib/sessionSchedule'
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
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const response = await api.getSessions()
            const current = queryClient.getQueryData<CachedSessionsResponse>(queryKeys.sessions)
            const cached = new Map(current?.sessions.map(s => [s.id, s]))
            const sessions: CachedSessionsResponse['sessions'] = response.sessions.map(session => {
                const prior = cached.get(session.id)
                cached.delete(session.id)
                return {
                    ...reconcileSessionSchedule(session, response.sessionScheduleCursor, prior),
                    lastUserMessageAt: Math.max(prior?.lastUserMessageAt ?? 0, session.lastUserMessageAt ?? 0) || undefined,
                    contentRevision: Math.max(prior?.contentRevision ?? 0, session.contentRevision ?? 0),
                    readState: mergeReadState(prior?.readState, session.readState)
                }
            })
            // Only rows inserted after this snapshot can legitimately be missing from it.
            for (const session of cached.values()) {
                if (isNewerSessionListEvent(session.sessionListInsertionEventId, response.sessionScheduleCursor)) {
                    sessions.push(session)
                }
            }
            sessions.sort(compareSessionSummaries)
            return reconcileAttachedJobsFromCache({ ...response, sessions }, current)
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
