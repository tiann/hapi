import type { AttachmentAdapter, PendingAttachment, CompleteAttachment, Attachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

type PendingUploadAttachment = PendingAttachment & {
    path?: string
    previewUrl?: string
}

export function createAttachmentAdapter(api: ApiClient, sessionId: string): AttachmentAdapter {
    const cancelledAttachmentIds = new Set<string>()

    const deleteUpload = async (path?: string) => {
        if (!path) return
        try {
            await api.deleteUploadFile(sessionId, path)
        } catch {
            // Best effort cleanup
        }
    }

    return {
        accept: '*/*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            const id = crypto.randomUUID()
            const contentType = file.type || 'application/octet-stream'

            yield {
                id,
                type: 'file',
                name: file.name,
                contentType,
                file,
                status: { type: 'running', reason: 'uploading', progress: 0 }
            }

            try {
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

                const content = await fileToBase64(file)
                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 50 }
                }

                const result = await api.uploadFile(sessionId, file.name, content, contentType)
                if (cancelledAttachmentIds.has(id)) {
                    if (result.success && result.path) {
                        await deleteUpload(result.path)
                    }
                    return
                }

                if (!result.success || !result.path) {
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

                // Generate preview URL for images under 5MB
                let previewUrl: string | undefined
                if (isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    previewUrl = await fileToDataUrl(file)
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: result.path,
                    previewUrl
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
            const path = (attachment as PendingUploadAttachment).path
            await deleteUpload(path)
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const pending = attachment as PendingUploadAttachment
            const path = pending.path

            // Build AttachmentMetadata to be sent with the message
            const metadata: AttachmentMetadata | undefined = path ? {
                id: attachment.id,
                filename: attachment.name,
                mimeType: attachment.contentType ?? 'application/octet-stream',
                size: attachment.file?.size ?? 0,
                path,
                previewUrl: pending.previewUrl
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
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const result = reader.result as string
            const base64 = result.split(',')[1]
            if (!base64) {
                reject(new Error('Failed to read file'))
                return
            }
            resolve(base64)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
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
