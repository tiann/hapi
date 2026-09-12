/**
 * Shared eligibility for a voice dictation direct-send.
 *
 * Mirrors `handleSend`'s dictation branch so the visible Send button
 * (HappyComposer) and the send path itself can never disagree.
 *
 * `blocksScheduling` must come from the composer's full attachment
 * accounting (visible + hidden persisted + still-hydrating drafts, see
 * HappyComposer's `blocksScheduling`): an inactive composer keeps
 * persisted attachment blobs out of the visible `attachments` array, so
 * checking only visible attachments would expose direct Send for an
 * inactive session whose hidden drafts would then be stranded on the
 * obsolete source session after resume.
 */
export function dictationDirectSendEligible(args: {
    active: boolean
    /** True when a session resolver (inactive-session resume) is available. */
    resolveSessionIdAvailable: boolean
    /** Visible, hidden, or still-hydrating attachment drafts present. */
    blocksScheduling: boolean
    pendingSchedule: unknown
    scratchlistMode: boolean
}): boolean {
    return (args.active || args.resolveSessionIdAvailable)
        && !args.blocksScheduling
        && args.pendingSchedule == null
        && !args.scratchlistMode
}

/**
 * Whether the given pathname is the session detail page for `sessionId`.
 * Used to avoid navigating away from where the operator currently is when
 * a background voice send completes after they left the source session.
 */
export function isOnSessionPage(pathname: string, sessionId: string): boolean {
    return pathname.replace(/\/$/, '') === `/sessions/${sessionId}`
}
