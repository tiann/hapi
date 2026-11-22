import type { AttachmentAdapter, PendingAttachment, CompleteAttachment, Attachment } from '@assistant-ui/react'
import {
    DEFAULT_UPLOAD_CHUNK_BYTES,
    LEGACY_SINGLE_UPLOAD_MAX_BYTES,
    MAX_CONFIGURABLE_UPLOAD_BYTES,
    UPLOAD_CHUNK_MAX_BYTES
} from '@hapi/protocol/apiTypes'
import { ApiError, type ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { randomId } from '@/lib/randomId'
import { getRestoredUploadMetadata } from '@/lib/composer-attachment-drafts'
import type { AttachmentDraftHandoff } from '@/lib/composer-draft-transfer'

/** Client sanity ceiling matching the Hub/CLI max configurable byte limit (10 GiB). */
export const MAX_UPLOAD_BYTES = MAX_CONFIGURABLE_UPLOAD_BYTES
/** Files above 8 MiB stream in chunks instead of buffering base64 in browser memory. */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = UPLOAD_CHUNK_MAX_BYTES
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

type ActiveUploadEntry = {
    chunkController: AbortController
    uploadSessionId: string
    uploadId?: string
    abortSent?: boolean
    finalizing?: boolean
}

function isNonRetryableUploadError(error: unknown, code?: string): boolean {
    if (code === 'upload_too_large') {
        return true
    }
    return error instanceof ApiError && (error.status === 413 || error.code === 'upload_too_large')
}

function isUnsupportedChunkedUploadError(error: unknown, code?: string): boolean {
    if (code === 'rpc_target_missing') {
        return true
    }
    if (!(error instanceof ApiError)) {
        return false
    }
    return error.code === 'rpc_target_missing'
        || (error.status === 404 && error.code !== 'Session not found')
}

type PendingUploadAttachment = PendingAttachment & {
    path?: string
    previewUrl?: string
    uploadSessionId?: string
    retryable?: boolean
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
    const activeUploads = new Map<string, ActiveUploadEntry>()

    const deleteUpload = async (path?: string, uploadSessionId = sessionId) => {
        if (!path) return
        try {
            await api.deleteUploadFile(uploadSessionId, path)
        } catch {
            // Best effort cleanup
        }
    }

    const abortActiveChunkedUpload = (entry: ActiveUploadEntry | undefined) => {
        if (!entry || entry.abortSent || !entry.uploadId) {
            return
        }
        entry.abortSent = true
        void api.abortChunkedUpload(entry.uploadSessionId, entry.uploadId).catch(() => {})
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
            if (!resolveSessionId && restored?.path) {
                yield {
                    id: restored.id,
                    type: 'file',
                    name: file.name,
                    contentType: file.type || 'application/octet-stream',
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: restored.path,
                    previewUrl: restored.previewUrl,
                    uploadSessionId: restored.uploadSessionId,
                } as PendingUploadAttachment
                return
            }

            const id = restored?.id ?? randomId()
            const contentType = file.type || 'application/octet-stream'
            const makeIncomplete = (retryable: boolean): PendingUploadAttachment => ({
                id,
                type: 'file',
                name: file.name,
                contentType,
                file,
                status: { type: 'incomplete', reason: 'error' },
                retryable,
            } as PendingUploadAttachment)

            let previewUrl: string | undefined
            let activeEntry: ActiveUploadEntry | undefined
            let finalized = false

            try {
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
                    yield makeIncomplete(false)
                    return
                }

                const uploadSessionId = resolveSessionId ? await resolveSessionId() : sessionId
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

                let useLegacySingleUpload = file.size <= CHUNKED_UPLOAD_THRESHOLD_BYTES

                if (!useLegacySingleUpload) {
                    const chunkController = new AbortController()
                    activeEntry = { chunkController, uploadSessionId }
                    activeUploads.set(id, activeEntry)

                    let initResult: Awaited<ReturnType<ApiClient['initChunkedUpload']>> | null = null
                    let chunkedUnsupported = false
                    try {
                        initResult = await api.initChunkedUpload(
                            uploadSessionId,
                            { filename: file.name, size: file.size, mimeType: contentType }
                        )
                    } catch (error) {
                        if (cancelledAttachmentIds.has(id)) {
                            return
                        }
                        if (isUnsupportedChunkedUploadError(error)) {
                            chunkedUnsupported = true
                        } else {
                            throw error
                        }
                    }

                    if (initResult?.success && initResult.uploadId) {
                        activeEntry.uploadId = initResult.uploadId
                    }

                    if (cancelledAttachmentIds.has(id)) {
                        abortActiveChunkedUpload(activeEntry)
                        return
                    }

                    if (!chunkedUnsupported && initResult && !initResult.success) {
                        if (isUnsupportedChunkedUploadError(undefined, initResult.code)) {
                            chunkedUnsupported = true
                        } else {
                            yield makeIncomplete(!isNonRetryableUploadError(undefined, initResult.code))
                            return
                        }
                    }

                    if (chunkedUnsupported) {
                        activeUploads.delete(id)
                        activeEntry = undefined
                        if (file.size > LEGACY_SINGLE_UPLOAD_MAX_BYTES) {
                            yield makeIncomplete(false)
                            return
                        }
                        useLegacySingleUpload = true
                    } else if (!initResult?.uploadId) {
                        yield makeIncomplete(true)
                        return
                    } else {
                        const uploadId = initResult.uploadId
                        const chunkSize = Math.min(
                            Math.max(1, initResult.chunkSize ?? DEFAULT_UPLOAD_CHUNK_BYTES),
                            UPLOAD_CHUNK_MAX_BYTES
                        )
                        const totalChunks = Math.ceil(file.size / chunkSize)

                        for (let index = 0; index < totalChunks; index += 1) {
                            if (cancelledAttachmentIds.has(id)) {
                                abortActiveChunkedUpload(activeEntry)
                                return
                            }
                            const start = index * chunkSize
                            const end = Math.min(start + chunkSize, file.size)
                            const chunkRes = await api.uploadFileChunk(
                                uploadSessionId,
                                uploadId,
                                index,
                                file.slice(start, end),
                                { signal: chunkController.signal }
                            )
                            if (cancelledAttachmentIds.has(id)) {
                                abortActiveChunkedUpload(activeEntry)
                                return
                            }
                            if (!chunkRes.success) {
                                abortActiveChunkedUpload(activeEntry)
                                yield makeIncomplete(!isNonRetryableUploadError(undefined, chunkRes.code))
                                return
                            }
                            const progress = Math.min(99, Math.max(1, Math.round((end / file.size) * 95)))
                            yield {
                                id,
                                type: 'file',
                                name: file.name,
                                contentType,
                                file,
                                status: { type: 'running', reason: 'uploading', progress },
                                previewUrl
                            } as PendingUploadAttachment
                        }

                        activeEntry.finalizing = true
                        const finalResult = await api.finalizeChunkedUpload(
                            uploadSessionId,
                            uploadId
                        )

                        if (cancelledAttachmentIds.has(id)) {
                            if (finalResult.success && finalResult.path) {
                                finalized = true
                                await deleteUpload(finalResult.path, uploadSessionId)
                            } else {
                                activeEntry.finalizing = false
                                abortActiveChunkedUpload(activeEntry)
                            }
                            return
                        }

                        if (!finalResult.success || !finalResult.path) {
                            activeEntry.finalizing = false
                            abortActiveChunkedUpload(activeEntry)
                            yield makeIncomplete(!isNonRetryableUploadError(undefined, finalResult.code))
                            return
                        }

                        finalized = true

                        yield {
                            id,
                            type: 'file',
                            name: file.name,
                            contentType,
                            file,
                            status: { type: 'requires-action', reason: 'composer-send' },
                            path: finalResult.path,
                            previewUrl,
                            uploadSessionId,
                        } as PendingUploadAttachment
                        return
                    }
                }

                if (useLegacySingleUpload) {
                    const content = previewUrl
                        ? base64FromDataUrl(previewUrl)
                        : await fileToBase64(file)

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

                    const result = await api.uploadFile(uploadSessionId, file.name, content, contentType)
                    if (cancelledAttachmentIds.has(id)) {
                        if (result.success && result.path) {
                            await deleteUpload(result.path, uploadSessionId)
                        }
                        return
                    }

                    if (!result.success || !result.path) {
                        yield makeIncomplete(!isNonRetryableUploadError(undefined, result.code))
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
                        previewUrl,
                        uploadSessionId,
                    } as PendingUploadAttachment
                }

            } catch (error) {
                if (!finalized) {
                    abortActiveChunkedUpload(activeEntry)
                }
                if (cancelledAttachmentIds.has(id)) {
                    return
                }
                yield makeIncomplete(!isNonRetryableUploadError(error))
            } finally {
                activeUploads.delete(id)
            }
        },

        async remove(attachment: Attachment): Promise<void> {
            cancelledAttachmentIds.add(attachment.id)
            const active = activeUploads.get(attachment.id)
            if (active) {
                active.chunkController.abort()
                if (!active.finalizing) {
                    abortActiveChunkedUpload(active)
                }
            }
            const path = (attachment as PendingUploadAttachment).path
            const uploadSessionId = (attachment as PendingUploadAttachment).uploadSessionId
            // The composer waits for remove() before dropping the chip. Remote
            // cleanup is best effort and must not delay that local update.
            void deleteUpload(path, uploadSessionId)
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
    return base64FromDataUrl(await fileToDataUrl(file))
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
