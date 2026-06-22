import type { ScratchlistAttachmentLimits, ScratchlistAttachmentMetadata } from '@hapi/protocol'

export type ScratchlistAttachmentValidationResult =
    | { ok: true }
    | { ok: false; error: string; code: string }

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
