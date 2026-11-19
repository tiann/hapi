import { useQuery, useQueryClient } from '@tanstack/react-query'
import { compareSessionSummaries, mergeReadState } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
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
            // SSE may have delivered newer input while this GET was in flight.
            // Retain its monotonic ordering clock, not deleted rows or stale data.
            const current = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            const cached = new Map(current?.sessions.map(s => [s.id, s]))
            const withClocks: SessionsResponse = {
                ...response,
                sessions: response.sessions.map(session => {
                    const prior = cached.get(session.id)
                    // A list GET can be captured BEFORE a clear and land after
                    // SSE applied it, which would re-blocked the row from a
                    // stale body. The blocker fields carry their own revision
                    // for exactly this; keep the newer side, as the SSE path
                    // and attachedJob reconciliation already do.
                    const priorNotifyAt = prior?.notifyUpdatedAt ?? 0
                    const keepPriorNotify = prior !== undefined
                        && priorNotifyAt > (session.notifyUpdatedAt ?? 0)
                    // Pending requests move on `agentStateVersion`, which
                    // advances when a prompt is ANSWERED even though the notify
                    // revision may not. Governing them by the notify revision
                    // let a stale snapshot restore an answered prompt.
                    const keepPriorPending = prior !== undefined
                        && (prior.agentStateVersion ?? 0) > (session.agentStateVersion ?? 0)
                    return { ...session,
                        // The pending-request fields are part of the same
                        // blocker picture: keeping the newer footer while
                        // taking older pending data brought an answered prompt
                        // back into Blocked and re-fired the arrival alert.
                        ...(keepPriorNotify && prior !== undefined
                            ? {
                                lastNotify: prior.lastNotify ?? null,
                                blockedAck: prior.blockedAck ?? null,
                                notifyUpdatedAt: priorNotifyAt
                            }
                            : {}),
                        ...(keepPriorPending && prior !== undefined
                            ? {
                                pendingRequestsCount: prior.pendingRequestsCount,
                                pendingRequestKinds: prior.pendingRequestKinds,
                                pendingRequests: prior.pendingRequests,
                                pendingRequestsNewestAt: prior.pendingRequestsNewestAt,
                                agentStateVersion: prior.agentStateVersion
                            }
                            : {}),
                        lastUserMessageAt: Math.max(prior?.lastUserMessageAt ?? 0, session.lastUserMessageAt ?? 0) || undefined,
                        contentRevision: Math.max(prior?.contentRevision ?? 0, session.contentRevision ?? 0),
                        readState: mergeReadState(prior?.readState, session.readState)
                    }
                }).sort(compareSessionSummaries)
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
