import { clearDraft } from '@/lib/composer-drafts'
import {
    clearDraftAttachments,
    removeDraftAttachmentsById,
} from '@/lib/composer-attachment-drafts'
import { clearComposerDraftSnapshotIfText } from '@/lib/composer-draft-transfer'

function clearComposerDraft(
    sessionId: string,
    sentText?: string,
    sentAttachmentIds?: readonly string[],
): void {
    clearDraft(sessionId)
    if (sentAttachmentIds === undefined) {
        clearDraftAttachments(sessionId)
    } else {
        removeDraftAttachmentsById(sessionId, sentAttachmentIds)
    }
    if (sentText !== undefined) {
        if (sentAttachmentIds !== undefined) {
            clearComposerDraftSnapshotIfText(sessionId, sentText, sentAttachmentIds)
        } else {
            clearComposerDraftSnapshotIfText(sessionId, sentText)
        }
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
    sentAttachmentIds?: readonly string[],
): void {
    clearComposerDraft(sentSessionId, sentText, sentAttachmentIds)
    if (routeSessionId && sentSessionId !== routeSessionId) {
        clearComposerDraft(routeSessionId, sentText, sentAttachmentIds)
    }
}
