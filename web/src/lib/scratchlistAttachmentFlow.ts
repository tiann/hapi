import type { ScratchlistAttachmentMetadata } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'

async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const result = reader.result as string
            const base64 = result.split(',')[1]
            if (!base64) {
                reject(new Error('Failed to read attachment'))
                return
            }
            resolve(base64)
        }
        reader.onerror = reject
        reader.readAsDataURL(blob)
    })
}

export async function stageScratchlistAttachmentsForComposeSend(
    api: ApiClient,
    sessionId: string,
    attachments: ScratchlistAttachmentMetadata[]
): Promise<AttachmentMetadata[]> {
    const staged: AttachmentMetadata[] = []
    try {
        for (const attachment of attachments) {
            const blob = await api.fetchScratchlistAttachmentBlob(sessionId, attachment.id)
            const content = await blobToBase64(blob)
            const upload = await api.uploadFile(sessionId, attachment.filename, content, attachment.mimeType)
            if (!upload.success || !upload.path) {
                throw new Error(`Failed to stage attachment ${attachment.filename}`)
            }
            let previewUrl: string | undefined
            if (isImageMimeType(attachment.mimeType) && attachment.size <= 5 * 1024 * 1024) {
                previewUrl = `data:${attachment.mimeType};base64,${content}`
            }
            staged.push({
                id: attachment.id,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.size,
                path: upload.path,
                previewUrl
            })
        }
        return staged
    } catch (error) {
        await Promise.allSettled(
            staged.map((att) => api.deleteUploadFile(sessionId, att.path))
        )
        throw error
    }
}

export async function rehydrateScratchlistAttachmentsToComposer(
    api: ApiClient,
    sessionId: string,
    attachments: ScratchlistAttachmentMetadata[],
    composer: { addAttachment: (file: File) => Promise<void> }
): Promise<void> {
    for (const attachment of attachments) {
        const blob = await api.fetchScratchlistAttachmentBlob(sessionId, attachment.id)
        const file = new File([blob], attachment.filename, { type: attachment.mimeType })
        await composer.addAttachment(file)
    }
}
