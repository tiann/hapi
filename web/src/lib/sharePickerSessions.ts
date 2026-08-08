import type { SessionSummary } from '@/types/api'
import { DEFAULT_SESSION_PREVIEW_LIMIT } from '@/hooks/useSessionPreviewLimit'
import {
    normalizeSearch,
    sessionMatchesQuery,
    sessionMatchesTimeRange,
    type SessionTimeRange,
} from '@/components/SessionList'

export type SharePickerMachineLabelResolver = (machineId: string | null) => string

function sortByUpdatedAtDesc(sessions: SessionSummary[]): SessionSummary[] {
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Share-target session picker filter.
 * Empty query (and no date range): recent active sessions (capped).
 * Non-empty query and/or date range: all sessions matching those filters.
 */
export function filterSharePickerSessions(
    sessions: SessionSummary[],
    query: string,
    resolveMachineLabel: SharePickerMachineLabelResolver,
    timeRange: SessionTimeRange | null = null,
    previewLimit: number = DEFAULT_SESSION_PREVIEW_LIMIT,
): SessionSummary[] {
    const normalizedQuery = normalizeSearch(query)
    const sorted = sortByUpdatedAtDesc(sessions)
    const inRange = (session: SessionSummary) => sessionMatchesTimeRange(session, timeRange)

    if (normalizedQuery || timeRange) {
        return sorted.filter((session) => {
            if (!inRange(session)) return false
            if (!normalizedQuery) return true
            return sessionMatchesQuery(
                session,
                normalizedQuery,
                resolveMachineLabel(session.metadata?.machineId ?? null),
            )
        })
    }

    return sorted.filter((session) => session.active).slice(0, previewLimit)
}

/** Active sessions hidden by the empty-query cap (for "search for more" hint). */
export function countHiddenActiveSharePickerSessions(
    sessions: SessionSummary[],
    previewLimit: number = DEFAULT_SESSION_PREVIEW_LIMIT,
): number {
    const activeCount = sessions.filter((session) => session.active).length
    return Math.max(0, activeCount - previewLimit)
}
