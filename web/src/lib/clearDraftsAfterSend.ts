import { clearDraft } from '@/lib/composer-drafts'
import { clearDraftAttachments } from '@/lib/composer-attachment-drafts'
import { clearComposerDraftSnapshotIfText } from '@/lib/composer-draft-transfer'

function clearComposerDraft(sessionId: string, sentText?: string): void {
    clearDraft(sessionId)
    clearDraftAttachments(sessionId)
    if (sentText !== undefined) {
        clearComposerDraftSnapshotIfText(sessionId, sentText)
    }
}

/**
 * Clear draft(s) after a successful send.
 * When `resolveSessionId` swaps the session (e.g. inactive → resumed),
 * the sent ID differs from the route's session ID, so both must be cleared.
 */
export function clearDraftsAfterSend(
    sentSessionId: string,
    routeSessionId: string | null,
    sentText?: string,
): void {
    clearComposerDraft(sentSessionId, sentText)
    if (routeSessionId && sentSessionId !== routeSessionId) {
        clearComposerDraft(routeSessionId, sentText)
    }
}
