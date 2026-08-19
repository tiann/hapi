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
        // assistant-ui uses the exact "*" sentinel for an allow-all adapter.
        // "*/*" is forwarded to MIME matching and rejects every file before
        // this adapter's add() method can run.
        accept: '*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            // Upload paths are scoped to the session that created them. An
            // inactive composer may resume into a different session id, so its
            // persisted file must follow the normal resolve/transfer flow and
            // be uploaded again by the resumed composer. Pathless restored
            // metadata still supplies a stable id so draft merge cannot
            // duplicate the same File across persistence passes.
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

                if (cancelledAttachmentIds.has(id)) {
                    return
                }

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
                // Resume may already have merged the source session away. Always
                // hand off with a live cancellation predicate so transfer can
                // drop this id (even if already persisted on the source draft).
                if (uploadSessionId !== sessionId && onSessionResolved) {
                    await onSessionResolved(uploadSessionId, {
                        id,
                        file,
                        previewUrl,
                        isCancelled: () => cancelledAttachmentIds.has(id),
                    })
                    return
                }
                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                // Reuse the preview Data URL only as the original payload: it
                // was read directly from the File above and has not been
                // resized or recompressed. The derived thumbnail is uploaded
                // separately and never replaces the original bytes.
                const content = previewUrl
                    ? base64FromDataUrl(previewUrl)
                    : await fileToBase64(file)
                const thumbnail = isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES
                    ? await createThumbnailDataUrl(`data:${contentType};base64,${content}`)
                    : undefined

                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 50 },
                    previewUrl
                } as PendingUploadAttachment

                const result = thumbnail
                    ? await api.uploadFile(uploadSessionId, file.name, content, contentType, thumbnail)
                    : await api.uploadFile(uploadSessionId, file.name, content, contentType)
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

            // Build AttachmentMetadata to be sent with the message
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
                // Store metadata as JSON in the text content for extraction by assistant-runtime
                content: metadata ? [{ type: 'text', text: JSON.stringify({ __attachmentMetadata: metadata }) }] : []
            }
        }
    }
}

async function fileToBase64(file: File): Promise<string> {
    return base64FromDataUrl(await fileToDataUrl(file))
}

async function createThumbnailDataUrl(dataUrl: string): Promise<{ content: string; mimeType: string } | undefined> {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return undefined
    try {
        const canvas = document.createElement('canvas')
        if (typeof canvas.toBlob !== 'function') return undefined
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const element = new Image()
            const timeout = window.setTimeout(() => reject(new Error('Image decode timed out')), 250)
            element.onload = () => {
                window.clearTimeout(timeout)
                resolve(element)
            }
            element.onerror = () => {
                window.clearTimeout(timeout)
                reject(new Error('Failed to decode image'))
            }
            element.src = dataUrl
        })
        const maxSide = 768
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
        canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
        canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
        const context = canvas.getContext('2d')
        if (!context) return undefined
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))
        if (!blob) return undefined
        return { content: await blobToBase64(blob), mimeType: blob.type || 'image/webp' }
    } catch {
        // Thumbnail creation is an optional UI optimization. Uploading the
        // original must continue when a browser cannot decode or encode it.
        return undefined
    }
}

async function blobToBase64(blob: Blob): Promise<string> {
    return base64FromDataUrl(await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
    }))
}

function base64FromDataUrl(dataUrl: string): string {
    const separatorIndex = dataUrl.indexOf(',')
    const base64 = separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : ''
    if (!base64) {
        throw new Error('Failed to read file')
    }
    return base64
}

async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            resolve(reader.result as string)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}
