import {
    isHubScratchlistAttachmentPath,
    type ScratchlistAttachmentMetadata,
} from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { hubAttachmentFromRestoredDraft } from '@/lib/scratchlistAttachmentAdapter'

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

/** Client-only marker stashed on park payloads after chat→hub migrate (#1226). */
export type ParkAttachmentMetadata = AttachmentMetadata & {
    migratedFromPath?: string
}

/** True when any composer attachment still lives on the normal chat upload path. */
export function attachmentsNeedScratchlistMigration(
    attachments: AttachmentMetadata[] | undefined
): boolean {
    return (attachments ?? []).some((att) => !isHubScratchlistAttachmentPath(att.path))
}

/** Result of preparing a scratchlist park (migrate only — add happens in commit). */
export type ScratchlistParkPrepared = {
    /** Drop orphan hub blobs created during prepare (snapshot changed / give up). */
    abort: () => Promise<void>
    /** Persist the entry. On false, orphans are already cleaned. */
    commit: () => Promise<boolean>
    /** After successful commit + snapshot still matches: delete chat uploads + release chips. */
    beforeClear: () => Promise<void>
}

export type ScratchlistParkResult = false | ScratchlistParkPrepared

/**
 * - accepted: drop the original chat uploads (hub blobs are on the entry)
 * - rejected: drop the orphan hub blobs so retry can re-migrate from chat paths
 */
export async function finalizeMigratedScratchlistParkCleanup(
    api: ApiClient,
    sessionId: string,
    attachments: AttachmentMetadata[] | undefined,
    accepted: boolean,
): Promise<void> {
    const list = (attachments ?? []) as ParkAttachmentMetadata[]
    const migrated = list.filter((att) => typeof att.migratedFromPath === 'string' && att.migratedFromPath.length > 0)
    if (migrated.length === 0) return

    if (accepted) {
        await Promise.allSettled(
            migrated.map((att) => api.deleteUploadFile(sessionId, att.migratedFromPath!))
        )
        return
    }

    await Promise.allSettled(
        migrated.map((att) => api.deleteScratchlistAttachment(sessionId, att.id))
    )
}

/**
 * Pending composer chip shape used when parking *before* assistant-ui
 * `composer.send()` empties the UI (#1226 follow-up Major).
 */
export type PendingParkAttachment = {
    id: string
    name: string
    contentType?: string
    file?: File
    path?: string
    hubAttachment?: ScratchlistAttachmentMetadata
    previewUrl?: string
}

/**
 * Build hub park metadata from live composer chips without clearing them.
 * Chat-path items are migrated into hub storage and stamped with
 * `migratedFromPath`; the original chat upload is left in place until
 * `finalizeMigratedScratchlistParkCleanup(accepted=true)`.
 */
export async function prepareScratchlistParkAttachments(
    api: ApiClient,
    sessionId: string,
    pending: readonly PendingParkAttachment[],
): Promise<ParkAttachmentMetadata[]> {
    const prepared: ParkAttachmentMetadata[] = []
    const createdHubIds: string[] = []
    try {
        for (const chip of pending) {
            const contentType = chip.contentType || chip.file?.type || 'application/octet-stream'
            const hubAttachment = chip.hubAttachment
                ?? (chip.path && chip.file
                    ? hubAttachmentFromRestoredDraft(chip.path, chip.file, contentType)
                    : null)
            if (hubAttachment) {
                prepared.push({
                    ...hubAttachment,
                    previewUrl: chip.previewUrl,
                })
                continue
            }
            const file = chip.file
            if (!file) {
                throw new Error(`Cannot park attachment ${chip.name} without file bytes`)
            }
            const content = await blobToBase64(file)
            const result = await api.uploadScratchlistAttachment(
                sessionId,
                chip.name,
                content,
                contentType,
            )
            if (!result.success || !result.attachment) {
                throw new Error(
                    result.error ?? `Failed to migrate attachment ${chip.name}`
                )
            }
            createdHubIds.push(result.attachment.id)
            const migratedFromPath =
                chip.path && !isHubScratchlistAttachmentPath(chip.path)
                    ? chip.path
                    : undefined
            prepared.push({
                ...result.attachment,
                previewUrl: chip.previewUrl,
                ...(migratedFromPath ? { migratedFromPath } : {}),
            })
        }
        return prepared
    } catch (error) {
        await Promise.allSettled(
            createdHubIds.map((id) => api.deleteScratchlistAttachment(sessionId, id))
        )
        throw error
    }
}

/**
 * Re-upload chat-path attachments into hub scratchlist storage (#1226).
 *
 * Does **not** delete the original chat upload — callers must run
 * `finalizeMigratedScratchlistParkCleanup` after the park attempt so a
 * rejected add can retry from the chat path. On failure, newly created
 * hub blobs are deleted so a partial migrate does not leak quota.
 */
export async function migrateChatPathAttachmentsToScratchlist(
    api: ApiClient,
    sessionId: string,
    attachments: AttachmentMetadata[],
    readContentBase64: (attachment: AttachmentMetadata) => Promise<string>
): Promise<ParkAttachmentMetadata[]> {
    const migrated: ParkAttachmentMetadata[] = []
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
            migrated.push({
                ...result.attachment,
                previewUrl: attachment.previewUrl,
                migratedFromPath: attachment.path,
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
