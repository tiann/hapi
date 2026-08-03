import type { SessionSummary } from '@/types/api'

/**
 * Project-group bulk-action guards (tiann/hapi#881).
 *
 * A session's lifecycle is tracked by `metadata.lifecycleState`
 * ('running' | 'archived' | undefined) alongside the live `active` flag.
 */

/** A session is "archived" only when its lifecycle metadata says so —
 *  `active === false` alone is not enough (imported/completed stubs are
 *  inactive but never formally archived). */
export function isSessionArchived(session: SessionSummary): boolean {
    return session.metadata?.lifecycleState === 'archived'
}

/** A session can be archived when it is live, or split-brain (inactive cache
 *  row whose lifecycle metadata still reads 'running'). Matches the archive
 *  route's accept condition in hub/src/web/routes/sessions.ts. */
export function isSessionArchivable(session: SessionSummary): boolean {
    return session.active || session.metadata?.lifecycleState === 'running'
}

export type ProjectGroupActionAvailability = {
    /** At least one session can be archived. */
    canArchiveAll: boolean
    /** Every session is already archived — the precondition for deleting the
     *  whole group (deliberate two-step: archive everything, then delete). */
    canDelete: boolean
}

export function getProjectGroupActionAvailability(
    sessions: SessionSummary[]
): ProjectGroupActionAvailability {
    return {
        canArchiveAll: sessions.some(isSessionArchivable),
        canDelete: sessions.length > 0 && sessions.every(isSessionArchived)
    }
}

export const OLD_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Old-session cleanup intentionally requires both conditions: inactive and
 *  not updated within the last seven days. */
export function isOldInactiveSession(
    session: SessionSummary,
    now: number = Date.now()
): boolean {
    const hasPendingScheduledMessage = (session.uninvokedScheduledMessageCount
        ?? session.futureScheduledMessageCount) > 0
    const lastUserDataUpdateAt = Math.max(
        session.updatedAt,
        session.scratchlistUpdatedAt ?? 0
    )
    return !session.active
        && !hasPendingScheduledMessage
        && lastUserDataUpdateAt <= now - OLD_SESSION_AGE_MS
}
