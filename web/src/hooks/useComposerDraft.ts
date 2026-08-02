import { useEffect, useRef, useState } from 'react'
import { getDraft, saveDraft } from '@/lib/composer-drafts'
import {
    getDraftAttachments,
    saveDraftAttachments,
    type AttachmentDraftInput,
} from '@/lib/composer-attachment-drafts'

export type ComposerDraftHydration = {
    /** Session represented by this status; prevents a previous session's ready state leaking across a key change. */
    sessionId: string | undefined
    complete: boolean
    /** True when this hydration found and applied a persisted text or attachment draft. */
    restoredAny: boolean
}

/**
 * Manages draft save/restore lifecycle for a composer.
 *
 * - On mount: restores saved draft via `setText` (deferred by one animation frame)
 * - On mount: restores saved attachment files through the composer adapter
 * - On unmount: saves current text and attachment files as a draft
 * - The `draftReady` guard prevents saving before the initial restore completes,
 *   avoiding the case where the runtime's empty initial text overwrites a real draft.
 *
 * The returned status is deliberately session-keyed. Consumers that must not
 * overwrite persisted drafts (for example failed-send recovery after a keyed
 * remount) can wait until `complete` and then respect `restoredAny`.
 */
export function useComposerDraft(
    sessionId: string | undefined,
    composerText: string,
    attachments: readonly AttachmentDraftInput[],
    canRestoreAttachments: boolean,
    setText: (text: string) => void,
    addAttachment: (file: File) => Promise<void>,
): ComposerDraftHydration {
    const composerTextRef = useRef(composerText)
    composerTextRef.current = composerText
    const attachmentsRef = useRef(attachments)
    attachmentsRef.current = attachments

    const draftReadyRef = useRef(false)
    const attachmentsReadyRef = useRef(false)
    const [hydration, setHydration] = useState<ComposerDraftHydration>(() => ({
        sessionId,
        complete: sessionId === undefined,
        restoredAny: false,
    }))

    useEffect(() => {
        if (!sessionId) {
            setHydration({ sessionId: undefined, complete: true, restoredAny: false })
            return
        }

        draftReadyRef.current = false
        attachmentsReadyRef.current = false
        setHydration({ sessionId, complete: false, restoredAny: false })

        let disposed = false
        const frame = requestAnimationFrame(() => {
            const draft = getDraft(sessionId)
            const restoreText = Boolean(draft && !composerTextRef.current)
            if (restoreText) {
                // Mark before the external composer store gets its render so a
                // consumer never mistakes this persisted replacement for empty.
                setHydration({ sessionId, complete: !canRestoreAttachments, restoredAny: true })
                setText(draft!)
            }
            draftReadyRef.current = true

            if (!canRestoreAttachments) {
                if (!restoreText) setHydration({ sessionId, complete: true, restoredAny: false })
                return
            }

            void getDraftAttachments(sessionId).then(async (files) => {
                // The promise belongs to this session's effect. A later keyed
                // session can already be hydrating when it settles, so never
                // publish old status or rehydrate old files after disposal.
                if (disposed) return
                const restoreAttachments = attachmentsRef.current.length === 0 && files.length > 0
                // Text is already known to be restored; attachment presence by
                // itself is not. An upload can fail, so only successful adds
                // contribute to restoredAny in the final completion update.
                setHydration((current) => current.sessionId === sessionId
                    ? {
                        sessionId,
                        complete: false,
                        restoredAny: restoreText || current.restoredAny,
                    }
                    : current)
                let restoredAttachment = false
                if (restoreAttachments) {
                    for (const file of files) {
                        if (disposed) break
                        try {
                            await addAttachment(file)
                            restoredAttachment = true
                        } catch {
                            // Continue restoring remaining files; one failed
                            // attachment must not discard a successful sibling.
                        }
                    }
                }
                return restoredAttachment
            }).catch(() => {
                // Attachment draft read is best effort.
                return false
            }).then((restoredAttachment) => {
                if (!disposed) {
                    attachmentsReadyRef.current = true
                    setHydration((current) => current.sessionId === sessionId
                        ? {
                            ...current,
                            complete: true,
                            restoredAny: current.restoredAny || Boolean(restoredAttachment),
                        }
                        : current)
                }
            })
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

    return hydration
}
