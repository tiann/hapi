import { useQuery, useQueryClient } from '@tanstack/react-query'
import { compareSessionSummaries, mergeReadState } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { beginInitialSessionSchedules, isNewerSessionListEvent, reconcileSessionSchedule, type CachedSessionsResponse } from '@/lib/sessionSchedule'
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
            const initialSchedules = queryClient.getQueryData(queryKeys.sessions) === undefined
                ? beginInitialSessionSchedules(queryClient)
                : undefined
            const response = await api.getSessions().finally(initialSchedules?.close)
            const current = queryClient.getQueryData<CachedSessionsResponse>(queryKeys.sessions)
            const cached = new Map(current?.sessions.map(s => [s.id, s]))
            const sessions: CachedSessionsResponse['sessions'] = response.sessions.map(session => {
                const prior = cached.get(session.id)
                cached.delete(session.id)
                const reconciled = reconcileSessionSchedule(session, response.sessionScheduleCursor, prior)
                return {
                    ...reconcileSessionSchedule(
                        reconciled,
                        reconciled.sessionScheduleEventId ?? response.sessionScheduleCursor,
                        initialSchedules?.take(session.id, response.sessionScheduleCursor)
                    ),
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
            if (initialSchedules?.needsRecovery()) {
                const initialQuery = queryClient.getQueryCache().find({ queryKey: queryKeys.sessions, exact: true })
                // Wait for TanStack to commit this response before recovering, or it joins the initial GET.
                setTimeout(() => {
                    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.sessions, exact: true })
                    if (query === initialQuery && query?.state.status === 'success' && query.state.fetchStatus === 'idle') {
                        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions, exact: true })
                    }
                }, 0)
            }
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
