import { useEffect, useRef } from 'react'
import { getDraft, saveDraft } from '@/lib/composer-drafts'

/**
 * Manages draft save/restore lifecycle for a composer.
 *
 * - On mount: restores saved draft via `setText` (deferred by one animation frame)
 * - On unmount: saves current text as draft
 * - The `draftReady` guard prevents saving before the initial restore completes,
 *   avoiding the case where the runtime's empty initial text overwrites a real draft.
 */
export function useComposerDraft(
    sessionId: string | undefined,
    composerText: string,
    setText: (text: string) => void,
): void {
    const composerTextRef = useRef(composerText)
    composerTextRef.current = composerText

    const draftReadyRef = useRef(false)

    useEffect(() => {
        if (!sessionId) return

        const frame = requestAnimationFrame(() => {
            const draft = getDraft(sessionId)
            if (draft && !composerTextRef.current) {
                setText(draft)
            }
            draftReadyRef.current = true
        })

        return () => {
            cancelAnimationFrame(frame)
            if (draftReadyRef.current) {
                saveDraft(sessionId, composerTextRef.current)
            }
            draftReadyRef.current = false
        }
    }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
}
