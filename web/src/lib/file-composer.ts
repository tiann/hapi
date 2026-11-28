import { getDraft, saveDraft } from '@/lib/composer-drafts'
import { getLiveComposerDraft } from '@/hooks/useComposerDraft'

/** Wrap a workspace-relative path so the agent can spot it in the prompt. */
export function formatFileReference(relativePath: string): string {
    return `\`${relativePath}\``
}

/**
 * Append a file reference to a session's composer draft.
 *
 * On wide viewports the files panel sits beside a still-mounted composer, which
 * would never re-read the stored draft, so a live composer is edited directly.
 * Otherwise the composer is unmounted on the files routes: the draft is
 * persisted here and `useComposerDraft` restores it when the chat mounts.
 * Existing text is preserved and the reference is added on a new line.
 */
export function appendFileReferenceToComposerDraft(sessionId: string, relativePath: string): void {
    const reference = formatFileReference(relativePath)
    const live = getLiveComposerDraft(sessionId)
    const existing = (live ? live.getText() : getDraft(sessionId)).replace(/[ \t\r\n]+$/, '')
    const next = existing.length > 0 ? `${existing}\n${reference}` : reference
    if (live) {
        live.setText(next)
    }
    saveDraft(sessionId, next)
}
