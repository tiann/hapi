import type { AttachmentAdapter, Attachment, CompleteAttachment, PendingAttachment } from '@assistant-ui/react'
import type { ScratchlistAttachmentMetadata } from '@hapi/protocol'
import {
    isHubScratchlistAttachmentPath,
    parseHubScratchlistAttachmentPath,
} from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { getRestoredUploadMetadata } from '@/lib/composer-attachment-drafts'
import { isImageMimeType } from '@/lib/fileAttachments'
import { randomId } from '@/lib/randomId'

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

/** Matches hub `SCRATCHLIST_ATTACHMENT_ID_RE` — file names are `${uuid}-${filename}`. */
const HUB_ATTACHMENT_ID_PREFIX_RE =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-/i

type PendingScratchlistAttachment = PendingAttachment & {
    /** Mirrors chat upload adapter — HappyComposer treats requires-action + path as ready. */
    path?: string
    hubAttachment?: ScratchlistAttachmentMetadata
    previewUrl?: string
}

/** Rebuild hub metadata from a composer-draft path so remount does not re-upload. */
export function hubAttachmentFromRestoredDraft(
    path: string,
    file: File,
    contentType: string
): ScratchlistAttachmentMetadata | null {
    const key = parseHubScratchlistAttachmentPath(path)
    if (!key) return null
    const storedName = key.split('/').pop()
    if (!storedName) return null
    const match = storedName.match(HUB_ATTACHMENT_ID_PREFIX_RE)
    if (!match?.[1]) return null
    return {
        id: match[1],
        filename: file.name,
        mimeType: contentType,
        size: file.size,
        path,
    }
}

export type ScratchlistAttachmentAdapter = AttachmentAdapter & {
    /**
     * After a successful park, `clearAttachments()` still calls `remove()`.
     * Mark those chip ids so remove skips hub/chat deletes (blobs now live
     * on the scratchlist entry).
     */
    releaseWithoutDelete(ids: Iterable<string>): void
}

export function createScratchlistAttachmentAdapter(
    api: ApiClient,
    sessionId: string,
): ScratchlistAttachmentAdapter {
    const cancelledAttachmentIds = new Set<string>()
    const releasedWithoutDeleteIds = new Set<string>()

    return {
        // assistant-ui uses the exact "*" sentinel for an allow-all adapter.
        // "*/*" is forwarded to MIME matching and rejects every file before
        // this adapter's add() method can run.
        accept: '*',

        releaseWithoutDelete(ids: Iterable<string>): void {
            for (const id of ids) {
                releasedWithoutDeleteIds.add(id)
            }
        },

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            const contentType = file.type || 'application/octet-stream'
            const restored = getRestoredUploadMetadata(file)
            if (restored?.path) {
                const hubAttachment = hubAttachmentFromRestoredDraft(restored.path, file, contentType)
                if (hubAttachment) {
                    yield {
                        id: restored.id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'requires-action', reason: 'composer-send' },
                        path: restored.path,
                        hubAttachment,
                        previewUrl: restored.previewUrl,
                    } as PendingScratchlistAttachment
                    return
                }
            }

            const id = randomId()

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

                const result = await api.uploadScratchlistAttachment(
                    sessionId,
                    file.name,
                    content,
                    contentType
                )
                if (cancelledAttachmentIds.has(id)) {
                    if (result.success && result.attachment) {
                        await api.deleteScratchlistAttachment(sessionId, result.attachment.id).catch(() => {})
                    }
                    return
                }

                if (!result.success || !result.attachment) {
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

                let previewUrl: string | undefined
                if (isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    try {
                        previewUrl = await fileToDataUrl(file)
                    } catch {
                        // Preview generation is optional after the upload has succeeded.
                    }
                }

                if (cancelledAttachmentIds.has(id)) {
                    await api.deleteScratchlistAttachment(sessionId, result.attachment.id).catch(() => {})
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: result.attachment.path,
                    hubAttachment: result.attachment,
                    previewUrl
                } as PendingScratchlistAttachment
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
            if (releasedWithoutDeleteIds.delete(attachment.id)) {
                return
            }
            cancelledAttachmentIds.add(attachment.id)
            const pending = attachment as PendingScratchlistAttachment
            const hubId = pending.hubAttachment?.id
            if (hubId) {
                await api.deleteScratchlistAttachment(sessionId, hubId).catch(() => {})
                return
            }
            // Chat-path chip attached before scratchlist mode was enabled (#1226).
            if (pending.path && !isHubScratchlistAttachmentPath(pending.path)) {
                await api.deleteUploadFile(sessionId, pending.path).catch(() => {})
            }
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const pending = attachment as PendingScratchlistAttachment
            let hubAttachment = pending.hubAttachment
            let previewUrl = pending.previewUrl
            let migratedFromPath: string | undefined

            // Attach-before-mode: composer still holds a chat-path pending from
            // the normal upload adapter. Migrate into hub scratchlist storage
            // so park keeps the image (#1226). Fail closed (throw) — empty
            // content would park text-only and clear chips silently.
            //
            // Do NOT delete the chat-path upload here: send() runs before
            // scratchlist.add succeeds. If park is rejected (at-cap / 409 /
            // network), the composer keeps chips that still reference the
            // chat path; deleting early poisons retry and orphans the hub
            // blob. Cleanup is deferred to onSendForComposer.
            if (!hubAttachment) {
                const file = attachment.file
                if (!file) {
                    throw new Error('Cannot park scratchlist attachment without file bytes')
                }
                const contentType = attachment.contentType || file.type || 'application/octet-stream'
                const content = await fileToBase64(file)
                const result = await api.uploadScratchlistAttachment(
                    sessionId,
                    attachment.name,
                    content,
                    contentType
                )
                if (!result.success || !result.attachment) {
                    throw new Error(
                        result.error ?? 'Failed to migrate attachment to scratchlist storage'
                    )
                }
                hubAttachment = result.attachment
                if (
                    pending.path
                    && !isHubScratchlistAttachmentPath(pending.path)
                ) {
                    migratedFromPath = pending.path
                }
                if (!previewUrl && isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    previewUrl = await fileToDataUrl(file)
                }
            }

            return {
                id: attachment.id,
                type: attachment.type,
                name: attachment.name,
                contentType: attachment.contentType,
                status: { type: 'complete' },
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        __attachmentMetadata: {
                            ...hubAttachment,
                            previewUrl,
                            ...(migratedFromPath ? { migratedFromPath } : {}),
                        }
                    })
                }]
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

export function extractScratchlistAttachmentMetadata(
    attachments: import('@/types/api').AttachmentMetadata[] | undefined
): ScratchlistAttachmentMetadata[] {
    if (!attachments || attachments.length === 0) return []
    const out: ScratchlistAttachmentMetadata[] = []
    for (const att of attachments) {
        const rec = att as ScratchlistAttachmentMetadata & { previewUrl?: string }
        if (rec.path && rec.id && rec.filename && rec.mimeType && typeof rec.size === 'number') {
            out.push({
                id: rec.id,
                filename: rec.filename,
                mimeType: rec.mimeType,
                size: rec.size,
                path: rec.path
            })
        }
    }
    return out
}
