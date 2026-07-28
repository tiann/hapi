import { useEffect, useRef } from 'react'
import { getDraft, saveDraft } from '@/lib/composer-drafts'
import {
    getDraftAttachments,
    saveDraftAttachments,
    type AttachmentDraftInput,
} from '@/lib/composer-attachment-drafts'

/**
 * Manages draft save/restore lifecycle for a composer.
 *
 * - On mount: restores saved draft via `setText` (deferred by one animation frame)
 * - On mount: restores saved attachment files through the composer adapter
 * - On unmount: saves current text and attachment files as a draft
 * - The `draftReady` guard prevents saving before the initial restore completes,
 *   avoiding the case where the runtime's empty initial text overwrites a real draft.
 */
export function useComposerDraft(
    sessionId: string | undefined,
    composerText: string,
    attachments: readonly AttachmentDraftInput[],
    canRestoreAttachments: boolean,
    setText: (text: string) => void,
    addAttachment: (file: File) => Promise<void>,
): void {
    const composerTextRef = useRef(composerText)
    composerTextRef.current = composerText
    const attachmentsRef = useRef(attachments)
    attachmentsRef.current = attachments

    const draftReadyRef = useRef(false)
    const attachmentsReadyRef = useRef(false)

    useEffect(() => {
        if (!sessionId) return

        let disposed = false
        const frame = requestAnimationFrame(() => {
            const draft = getDraft(sessionId)
            if (draft && !composerTextRef.current) {
                setText(draft)
            }
            draftReadyRef.current = true
            if (canRestoreAttachments) {
                void getDraftAttachments(sessionId).then(async (files) => {
                    if (!disposed && attachmentsRef.current.length === 0) {
                        for (const file of files) {
                            if (disposed) break
                            await addAttachment(file)
                        }
                    }
                }).catch(() => {
                    // Attachment draft restoration is best effort.
                }).finally(() => {
                    if (!disposed) attachmentsReadyRef.current = true
                })
            }
        })

        return () => {
            disposed = true
            cancelAnimationFrame(frame)
            if (draftReadyRef.current) {
                saveDraft(sessionId, composerTextRef.current)
            }
            if (attachmentsRef.current.length > 0 || (canRestoreAttachments && attachmentsReadyRef.current)) {
                saveDraftAttachments(sessionId, [...attachmentsRef.current])
            }
            draftReadyRef.current = false
            attachmentsReadyRef.current = false
        }
    }, [sessionId, canRestoreAttachments]) // eslint-disable-line react-hooks/exhaustive-deps
}
