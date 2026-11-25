/**
 * Lets UI outside the chat (the files side panel) insert text into a session's
 * live composer at the caret the user last left there. The composer registers
 * an inserter while it is mounted; when none is registered (e.g. the files page
 * replaced the chat on a narrow screen) callers fall back to the stored draft.
 */
type ComposerInserter = (text: string) => void

const inserters = new Map<string, ComposerInserter>()

export function registerComposerInserter(sessionId: string, inserter: ComposerInserter): () => void {
    inserters.set(sessionId, inserter)
    return () => {
        if (inserters.get(sessionId) === inserter) {
            inserters.delete(sessionId)
        }
    }
}

/** Returns false when no composer for the session is mounted. */
export function insertIntoLiveComposer(sessionId: string, text: string): boolean {
    const inserter = inserters.get(sessionId)
    if (!inserter) return false
    inserter(text)
    return true
}

/**
 * Pad `insert` with spaces so it does not glue onto neighbouring words when
 * dropped into `text` at `selection`.
 */
export function padInsertion(text: string, selection: { start: number; end: number }, insert: string): string {
    const before = selection.start > 0 ? text[selection.start - 1] : ''
    const after = selection.end < text.length ? text[selection.end] : ''
    const leading = before && !/\s/.test(before) ? ' ' : ''
    const trailing = after && /\s/.test(after) ? '' : ' '
    return `${leading}${insert}${trailing}`
}
