import type { AttachmentAdapter, PendingAttachment, CompleteAttachment, Attachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { randomId } from '@/lib/randomId'
import { getRestoredUploadMetadata } from '@/lib/composer-attachment-drafts'
import type { AttachmentDraftHandoff } from '@/lib/composer-draft-transfer'

/** Composer / share upload ceiling — keep deep-link fetch in sync. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

type PendingUploadAttachment = PendingAttachment & {
    path?: string
    attachmentId?: string
    previewUrl?: string
    uploadSessionId?: string
}

export function createAttachmentAdapter(
    api: ApiClient,
    sessionId: string,
    resolveSessionId?: () => Promise<string>,
    // Always hand off after resume merges into a new session id — even when
    // the pick is cancelled — so the caller can navigate off a deleted source.
    // Cancellation is re-checked at transfer save time via isCancelled().
    onSessionResolved?: (sessionId: string, pending: AttachmentDraftHandoff) => Promise<void>,
): AttachmentAdapter {
    const cancelledAttachmentIds = new Set<string>()

    const deleteUpload = async (
        path?: string,
        attachmentId?: string,
        uploadSessionId = sessionId
    ) => {
        if (!path && !attachmentId) return
        try {
            if (attachmentId) {
                await api.deleteAttachment(uploadSessionId, attachmentId)
            } else if (path) {
                await api.deleteUploadFile(uploadSessionId, path)
            }
        } catch {
            // Best effort cleanup
        }
    }

    return {
        accept: '*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            const restored = getRestoredUploadMetadata(file)
            if (!resolveSessionId && (restored?.path || restored?.attachmentId)) {
                yield {
                    id: restored.id,
                    type: 'file',
                    name: file.name,
                    contentType: file.type || 'application/octet-stream',
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: restored.path,
                    attachmentId: restored.attachmentId,
                    previewUrl: restored.previewUrl,
                    uploadSessionId: restored.uploadSessionId,
                } as PendingUploadAttachment
                return
            }

            const id = restored?.id ?? randomId()
            const contentType = file.type || 'application/octet-stream'

            try {
                let previewUrl: string | undefined
                if (isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    try {
                        previewUrl = await fileToDataUrl(file)
                    } catch {
                        // Preview generation is optional; retry the read for the upload payload below.
                    }
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 0 },
                    previewUrl
                } as PendingUploadAttachment

                if (cancelledAttachmentIds.has(id)) return

                if (file.size > MAX_UPLOAD_BYTES) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                const uploadSessionId = resolveSessionId ? await resolveSessionId() : sessionId
                if (restored
                    && restored.uploadSessionId === uploadSessionId
                    && (restored.path || restored.attachmentId)) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'requires-action', reason: 'composer-send' },
                        path: restored.path,
                        attachmentId: restored.attachmentId,
                        previewUrl: restored.previewUrl,
                        uploadSessionId,
                    } as PendingUploadAttachment
                    return
                }

                if (uploadSessionId !== sessionId && onSessionResolved) {
                    await onSessionResolved(uploadSessionId, {
                        id,
                        file,
                        previewUrl,
                        isCancelled: () => cancelledAttachmentIds.has(id),
                    })
                    return
                }
                if (cancelledAttachmentIds.has(id)) return

                // The local preview is only for the composer. The Hub receives
                // the original bytes and new messages persist only attachmentId.
                const content = previewUrl
                    ? base64FromDataUrl(previewUrl)
                    : await fileToBase64(file)

                if (cancelledAttachmentIds.has(id)) return

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 50 },
                    previewUrl
                } as PendingUploadAttachment

                const result = await api.uploadFile(uploadSessionId, file.name, content, contentType)
                if (cancelledAttachmentIds.has(id)) {
                    if (result.success && (result.path || result.attachmentId)) {
                        await deleteUpload(result.path, result.attachmentId, uploadSessionId)
                    }
                    return
                }

                if (!result.success || (!result.path && !result.attachmentId)) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: result.path,
                    attachmentId: result.attachmentId,
                    previewUrl,
                    uploadSessionId,
                } as PendingUploadAttachment
            } catch {
                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'incomplete', reason: 'error' }
                }
            }
        },

        async remove(attachment: Attachment): Promise<void> {
            cancelledAttachmentIds.add(attachment.id)
            const pending = attachment as PendingUploadAttachment
            await deleteUpload(pending.path, pending.attachmentId, pending.uploadSessionId)
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const pending = attachment as PendingUploadAttachment
            const path = pending.path
            const attachmentId = pending.attachmentId

            const metadata: AttachmentMetadata | undefined = (path || attachmentId) ? {
                id: attachment.id,
                filename: attachment.name,
                mimeType: attachment.contentType ?? 'application/octet-stream',
                size: attachment.file?.size ?? 0,
                ...(path ? { path, previewUrl: pending.previewUrl } : {}),
                ...(attachmentId ? { attachmentId } : {})
            } : undefined

            return {
                id: attachment.id,
                type: attachment.type,
                name: attachment.name,
                contentType: attachment.contentType,
                status: { type: 'complete' },
                content: metadata ? [{ type: 'text', text: JSON.stringify({ __attachmentMetadata: metadata }) }] : []
            }
        }
    }
}

async function fileToBase64(file: File): Promise<string> {
    return base64FromDataUrl(await fileToDataUrl(file))
}

function base64FromDataUrl(dataUrl: string): string {
    const separatorIndex = dataUrl.indexOf(',')
    const base64 = separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : ''
    if (!base64) throw new Error('Failed to read file')
    return base64
}

async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}
