import type { ScratchlistAttachmentLimits, ScratchlistAttachmentMetadata } from '@hapi/protocol'

export type ScratchlistAttachmentValidationResult =
    | { ok: true }
    | { ok: false; error: string; code: string }

/**
 * Session byte budget ahead of a PUT that may replace attachments.
 * `diskBytes` still includes files this update is about to drop — subtract
 * those first so replacing an 80MB blob with another 80MB blob does not
 * falsely trip the session cap.
 */
export function scratchlistSessionBytesBeforeForPut(
    diskBytes: number,
    nextAttachments: Array<{ size: number }>,
    removedAttachments: Array<{ size: number }>,
): number {
    const entryBytes = nextAttachments.reduce((sum, att) => sum + att.size, 0)
    const removedBytes = removedAttachments.reduce((sum, att) => sum + att.size, 0)
    const diskBytesAfterRemoval = Math.max(0, diskBytes - removedBytes)
    return Math.max(0, diskBytesAfterRemoval - entryBytes)
}

export function validateScratchlistAttachmentsForWrite(
    attachments: ScratchlistAttachmentMetadata[],
    limits: ScratchlistAttachmentLimits,
    sessionBytesBefore: number
): ScratchlistAttachmentValidationResult {
    if (attachments.length > limits.maxAttachmentsPerEntry) {
        return {
            ok: false,
            error: `At most ${limits.maxAttachmentsPerEntry} attachments per scratchlist entry`,
            code: 'scratchlist_attachments_per_entry',
        }
    }

    let entryBytes = 0
    for (const att of attachments) {
        if (att.size > limits.maxBytesPerFile) {
            return {
                ok: false,
                error: `Attachment exceeds per-file limit (${limits.maxBytesPerFile} bytes)`,
                code: 'scratchlist_attachment_too_large',
            }
        }
        if (!limits.allowedMimeTypes.some((m) => m.toLowerCase() === att.mimeType.toLowerCase())) {
            return {
                ok: false,
                error: `Mime type not allowed: ${att.mimeType}`,
                code: 'scratchlist_attachment_mime',
            }
        }
        entryBytes += att.size
    }

    if (entryBytes > limits.maxBytesPerEntry) {
        return {
            ok: false,
            error: `Attachments exceed per-entry byte limit (${limits.maxBytesPerEntry} bytes)`,
            code: 'scratchlist_attachments_entry_bytes',
        }
    }

    if (sessionBytesBefore + entryBytes > limits.maxBytesPerSession) {
        return {
            ok: false,
            error: `Scratchlist attachments would exceed per-session byte limit (${limits.maxBytesPerSession} bytes)`,
            code: 'scratchlist_attachments_session_bytes',
        }
    }

    return { ok: true }
}
