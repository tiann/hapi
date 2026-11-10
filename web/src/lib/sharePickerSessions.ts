import type { SessionSummary } from '@/types/api'
import { DEFAULT_SESSION_PREVIEW_LIMIT } from '@/hooks/useSessionPreviewLimit'
import {
    normalizeSearch,
    sessionMatchesQuery,
} from '@/components/SessionList'

export type SharePickerMachineLabelResolver = (machineId: string | null) => string

function sortByUpdatedAtDesc(sessions: SessionSummary[]): SessionSummary[] {
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Share-target session picker filter.
 * Empty query: recent active sessions (capped).
 * Non-empty query: all sessions matching it.
 */
export function filterSharePickerSessions(
    sessions: SessionSummary[],
    query: string,
    resolveMachineLabel: SharePickerMachineLabelResolver,
    previewLimit: number = DEFAULT_SESSION_PREVIEW_LIMIT,
): SessionSummary[] {
    const normalizedQuery = normalizeSearch(query)
    const sorted = sortByUpdatedAtDesc(sessions)

    if (normalizedQuery) {
        return sorted.filter((session) => sessionMatchesQuery(
            session,
            normalizedQuery,
            resolveMachineLabel(session.metadata?.machineId ?? null),
        ))
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
