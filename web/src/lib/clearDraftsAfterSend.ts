import { clearDraft } from '@/lib/composer-drafts'
import { clearDraftAttachments } from '@/lib/composer-attachment-drafts'

function clearComposerDraft(sessionId: string): void {
    clearDraft(sessionId)
    clearDraftAttachments(sessionId)
}

/**
 * Clear draft(s) after a successful send.
 * When `resolveSessionId` swaps the session (e.g. inactive → resumed),
 * the sent ID differs from the route's session ID, so both must be cleared.
 */
export function clearDraftsAfterSend(
    sentSessionId: string,
    routeSessionId: string | null,
): void {
    clearComposerDraft(sentSessionId)
    if (routeSessionId && sentSessionId !== routeSessionId) {
        clearComposerDraft(routeSessionId)
    }
}
