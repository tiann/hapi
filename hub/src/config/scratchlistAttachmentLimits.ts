import {
    SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS,
    ScratchlistAttachmentLimitsSchema,
    type ScratchlistAttachmentLimits,
} from '@hapi/protocol'

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseMimeList(raw: string | undefined): string[] {
    if (!raw) return SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS.allowedMimeTypes
    const entries = raw.split(',').map((s) => s.trim()).filter(Boolean)
    return entries.length > 0 ? entries : SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS.allowedMimeTypes
}

export function loadScratchlistAttachmentLimitsFromEnv(): ScratchlistAttachmentLimits {
    const candidate = {
        maxBytesPerFile: parsePositiveInt(
            process.env.HAPI_SCRATCHLIST_MAX_ATTACHMENT_BYTES_PER_FILE,
            SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS.maxBytesPerFile
        ),
        maxAttachmentsPerEntry: parsePositiveInt(
            process.env.HAPI_SCRATCHLIST_MAX_ATTACHMENTS_PER_ENTRY,
            SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS.maxAttachmentsPerEntry
        ),
        maxBytesPerEntry: parsePositiveInt(
            process.env.HAPI_SCRATCHLIST_MAX_ATTACHMENT_BYTES_PER_ENTRY,
            SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS.maxBytesPerEntry
        ),
        maxBytesPerSession: parsePositiveInt(
            process.env.HAPI_SCRATCHLIST_MAX_ATTACHMENT_BYTES_PER_SESSION,
            SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS.maxBytesPerSession
        ),
        allowedMimeTypes: parseMimeList(process.env.HAPI_SCRATCHLIST_ALLOWED_ATTACHMENT_MIMES),
    }
    const parsed = ScratchlistAttachmentLimitsSchema.safeParse(candidate)
    return parsed.success ? parsed.data : SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS
}

export function isAllowedScratchlistMime(mimeType: string, limits: ScratchlistAttachmentLimits): boolean {
    const normalized = mimeType.trim().toLowerCase()
    return limits.allowedMimeTypes.some((allowed) => allowed.toLowerCase() === normalized)
}
