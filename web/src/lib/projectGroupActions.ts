import { isLiveLifecycleState } from '@hapi/protocol'
import type { SessionSummary } from '@hapi/protocol/types'

/**
 * Project-group bulk-action guards (tiann/hapi#881).
 *
 * A session's lifecycle is tracked by `metadata.lifecycleState`
 * ('running' | 'idle' | 'archived' | undefined) alongside the live `active` flag.
 */

/** A session is "archived" only when its lifecycle metadata says so —
 *  `active === false` alone is not enough (imported/completed stubs are
 *  inactive but never formally archived). */
export function isSessionArchived(session: SessionSummary): boolean {
    return !session.active && session.metadata?.lifecycleState === 'archived'
}

/** A session can be archived when it is live, or inactive with a live
 *  lifecycle ('running' | 'idle'). Matches the archive route's accept
 *  condition in hub/src/web/routes/sessions.ts. */
export function isSessionArchivable(session: SessionSummary): boolean {
    return session.active || isLiveLifecycleState(session.metadata?.lifecycleState)
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
