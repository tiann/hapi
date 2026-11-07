import { getDraft, saveDraft } from '@/lib/composer-drafts'

/**
 * Seeds a session's composer draft with `message`, but only if there isn't
 * already an unsent draft there — a board spawn's duplicate-merge/import/
 * reopen paths can resolve to an EXISTING session id that already has its
 * own unsent draft in this browser tab, and `saveDraft` overwrites
 * unconditionally, so seeding unconditionally would silently destroy it
 * (hapi#238 Codex review).
 */
export function seedComposerDraftIfEmpty(sessionId: string, message: string | null | undefined): void {
    if (!message?.trim()) return
    if (getDraft(sessionId).trim()) return
    saveDraft(sessionId, message)
}
