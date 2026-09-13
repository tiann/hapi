import { getDraft, saveDraft } from '@/lib/composer-drafts'

/** Wrap a workspace-relative path so the agent can spot it in the prompt. */
export function formatFileReference(relativePath: string): string {
    return `\`${relativePath}\``
}

/**
 * Append a file reference to a session's composer draft.
 *
 * The composer is unmounted on the files routes, so callers must persist the
 * draft here and then navigate back to the chat; `useComposerDraft` restores it
 * on mount. Existing text is preserved and the reference is added on a new line.
 */
export function appendFileReferenceToComposerDraft(sessionId: string, relativePath: string): void {
    const reference = formatFileReference(relativePath)
    const existing = getDraft(sessionId).replace(/[ \t\r\n]+$/, '')
    saveDraft(sessionId, existing.length > 0 ? `${existing}\n${reference}` : reference)
}
