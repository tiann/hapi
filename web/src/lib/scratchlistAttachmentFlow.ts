import {
    isHubScratchlistAttachmentPath,
    type ScratchlistAttachmentMetadata,
} from '@hapi/protocol'
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

/** True when any composer attachment still lives on the normal chat upload path. */
export function attachmentsNeedScratchlistMigration(
    attachments: AttachmentMetadata[] | undefined
): boolean {
    return (attachments ?? []).some((att) => !isHubScratchlistAttachmentPath(att.path))
}

/**
 * Re-upload chat-path attachments into hub scratchlist storage (#1226).
 *
 * `readContentBase64` supplies bytes for each chat-path item (typically from
 * the pending File still held by the composer adapter). Hub-resident items
 * are passed through unchanged. On failure, newly created hub blobs are
 * deleted so a partial migrate does not leak quota.
 */
export async function migrateChatPathAttachmentsToScratchlist(
    api: ApiClient,
    sessionId: string,
    attachments: AttachmentMetadata[],
    readContentBase64: (attachment: AttachmentMetadata) => Promise<string>
): Promise<AttachmentMetadata[]> {
    const migrated: AttachmentMetadata[] = []
    const createdHubIds: string[] = []
    try {
        for (const attachment of attachments) {
            if (isHubScratchlistAttachmentPath(attachment.path)) {
                migrated.push(attachment)
                continue
            }
            const content = await readContentBase64(attachment)
            const result = await api.uploadScratchlistAttachment(
                sessionId,
                attachment.filename,
                content,
                attachment.mimeType
            )
            if (!result.success || !result.attachment) {
                throw new Error(
                    result.error ?? `Failed to migrate attachment ${attachment.filename}`
                )
            }
            createdHubIds.push(result.attachment.id)
            await api.deleteUploadFile(sessionId, attachment.path).catch(() => {})
            migrated.push({
                ...result.attachment,
                previewUrl: attachment.previewUrl,
            })
        }
        return migrated
    } catch (error) {
        await Promise.allSettled(
            createdHubIds.map((id) => api.deleteScratchlistAttachment(sessionId, id))
        )
        throw error
    }
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
