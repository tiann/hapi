export type SpawnFlowRoute = '/sessions/new' | '/browse'

/**
 * Whether a navigation away from `fromPathname` (either leg of the board
 * spawn flow — `/sessions/new`, or its "Choose folder" detour through
 * `/browse`) should be treated as abandoning the flow, and so should clean
 * up its briefing/share-transfer stash. False only for staying put or
 * crossing between the two legs of the same deliberate round trip; true for
 * everything else, including browser/device back-driven navigation, which
 * runs no explicit Cancel/Back handler on either page (hapi#238 Codex
 * review, two passes — the second covering `/browse` specifically, which
 * has its own copy of the same briefing/transfer in its own search params
 * and no cleanup of its own).
 *
 * Staying on the SAME pathname or crossing to the other leg is only a
 * genuine continuation if the destination actually carries forward one of
 * the same ids this flow is tracking — pathname alone isn't enough. Two
 * concrete ways that showed up in practice: `/browse` is also the target of
 * the left sidebar's own, entirely unrelated global "Browse" button,
 * reachable while `/sessions/new` is open and carrying no transfer ids at
 * all (third Codex review pass); and the sidebar's "New Session" button
 * navigates to a bare `/sessions/new` with no search params — the SAME
 * pathname as an already-open board-spawn compose, which an unconditional
 * `toPathname === fromPathname` early return used to treat as "staying put"
 * regardless of whether the new destination actually carried the tracked
 * ids forward (fourth Codex review pass). Both cases orphaned the briefing
 * in sessionStorage instead of cleaning it up, resurrectable via browser
 * Back.
 */
export function isAbandoningSpawnFlow(
    fromPathname: SpawnFlowRoute,
    toPathname: string,
    currentIds: { briefingId?: string; shareTransferId?: string },
    toSearch: { briefingId?: unknown; shareTransferId?: unknown }
): boolean {
    const otherLeg: SpawnFlowRoute = fromPathname === '/sessions/new' ? '/browse' : '/sessions/new'
    if (toPathname !== fromPathname && toPathname !== otherLeg) return true

    // Nothing this flow is actually tracking — no stash to leak either way,
    // so the old pathname-only behavior is harmless here.
    if (!currentIds.briefingId && !currentIds.shareTransferId) return false

    const sameBriefing = currentIds.briefingId !== undefined && toSearch.briefingId === currentIds.briefingId
    const sameShareTransfer = currentIds.shareTransferId !== undefined && toSearch.shareTransferId === currentIds.shareTransferId
    return !(sameBriefing || sameShareTransfer)
}
