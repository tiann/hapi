import { useEffect, useRef, useState } from 'react'
import { getDraft, saveDraft } from '@/lib/composer-drafts'
import {
    getDraftAttachments,
    getRestoredUploadMetadata,
    saveDraftAttachments,
    type AttachmentDraftInput,
} from '@/lib/composer-attachment-drafts'
import { persistInactiveComposerAttachments, composerDraftWasHandedOff } from '@/lib/composer-draft-transfer'

export type ComposerDraftHydration = {
    /** Session represented by this status; prevents a previous session's ready state leaking across a key change. */
    sessionId: string | undefined
    complete: boolean
    /** True when this hydration found and applied a persisted text or attachment draft. */
    restoredAny: boolean
    /** True when IndexedDB still holds attachment blobs (even if not restored into the adapter). */
    hasStoredAttachments: boolean
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
        hasStoredAttachments: false,
    }))

    useEffect(() => {
        if (!sessionId) {
            setHydration({
                sessionId: undefined,
                complete: true,
                restoredAny: false,
                hasStoredAttachments: false,
            })
            return
        }

        draftReadyRef.current = false
        attachmentsReadyRef.current = false
        setHydration({
            sessionId,
            complete: false,
            restoredAny: false,
            hasStoredAttachments: false,
        })

        let disposed = false
        const frame = requestAnimationFrame(() => {
            const draft = getDraft(sessionId)
            const restoreText = Boolean(draft && !composerTextRef.current)
            if (restoreText) {
                // Mark before the external composer store gets its render so a
                // consumer never mistakes this persisted replacement for empty.
                setHydration({
                    sessionId,
                    complete: false,
                    restoredAny: true,
                    hasStoredAttachments: false,
                })
                setText(draft!)
            }
            draftReadyRef.current = true

            if (!canRestoreAttachments) {
                // Peek at stored blobs without restoring them into the inactive
                // adapter so schedule/exclusion UI still knows they exist.
                void getDraftAttachments(sessionId).then((files) => {
                    if (disposed) return
                    setHydration({
                        sessionId,
                        complete: true,
                        restoredAny: restoreText,
                        hasStoredAttachments: files.length > 0,
                    })
                }).catch(() => {
                    if (disposed) return
                    setHydration({
                        sessionId,
                        complete: true,
                        restoredAny: restoreText,
                        hasStoredAttachments: false,
                    })
                })
                return
            }

            void getDraftAttachments(sessionId).then(async (files) => {
                // The promise belongs to this session's effect. A later keyed
                // session can already be hydrating when it settles, so never
                // publish old status or rehydrate old files after disposal.
                if (disposed) return
                // Same-id resume can flip inactive→active with a newly visible
                // pick already in the adapter. Restore only missing stored ids
                // instead of skipping the whole draft when anything is visible.
                const visibleIds = new Set(attachmentsRef.current.map((item) => item.id))
                const filesToRestore = files.filter((file) => {
                    const id = getRestoredUploadMetadata(file)?.id
                    return !id || !visibleIds.has(id)
                })
                // Text is already known to be restored; attachment presence by
                // itself is not. An upload can fail, so only successful adds
                // contribute to restoredAny in the final completion update.
                setHydration((current) => current.sessionId === sessionId
                    ? {
                        sessionId,
                        complete: false,
                        restoredAny: restoreText || current.restoredAny,
                        hasStoredAttachments: files.length > 0,
                    }
                    : current)
                let restoredAttachment = false
                if (filesToRestore.length > 0) {
                    for (const file of filesToRestore) {
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
                return { restoredAttachment, hasStoredAttachments: files.length > 0 }
            }).catch(() => {
                // Attachment draft read is best effort.
                return { restoredAttachment: false, hasStoredAttachments: false }
            }).then((result) => {
                if (!disposed) {
                    attachmentsReadyRef.current = true
                    setHydration((current) => current.sessionId === sessionId
                        ? {
                            ...current,
                            complete: true,
                            restoredAny: current.restoredAny || Boolean(result?.restoredAttachment),
                            hasStoredAttachments: Boolean(result?.hasStoredAttachments),
                        }
                        : current)
                }
            })
        })

        return () => {
            disposed = true
            cancelAnimationFrame(frame)
            // Cross-session resume already moved this draft; do not recreate the
            // obsolete source id after the route change unmounts the composer.
            if (composerDraftWasHandedOff(sessionId)) {
                draftReadyRef.current = false
                attachmentsReadyRef.current = false
                return
            }
            if (draftReadyRef.current) {
                saveDraft(sessionId, composerTextRef.current)
            }
            if (canRestoreAttachments && (attachmentsRef.current.length > 0 || attachmentsReadyRef.current)) {
                saveDraftAttachments(sessionId, [...attachmentsRef.current])
            } else if (!canRestoreAttachments && attachmentsRef.current.length > 0) {
                // Merge visible pending picks into IndexedDB; do not replace the
                // hidden stored list with only the incomplete visible set.
                void persistInactiveComposerAttachments(
                    sessionId,
                    composerTextRef.current,
                    attachmentsRef.current,
                ).catch((error) => {
                    console.warn('[composer-draft] inactive persistence failed', error)
                })
            }
            draftReadyRef.current = false
            attachmentsReadyRef.current = false
        }
    }, [sessionId, canRestoreAttachments]) // eslint-disable-line react-hooks/exhaustive-deps

    return hydration
}
