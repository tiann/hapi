import { z } from 'zod'

/** Hub-resident scratchlist files use this path prefix in AttachmentMetadata.path */
export const HUB_SCRATCHLIST_ATTACHMENT_PATH_PREFIX = 'hapi-hub:scratchlist/'

export function isHubScratchlistAttachmentPath(path: string): boolean {
    return path.startsWith(HUB_SCRATCHLIST_ATTACHMENT_PATH_PREFIX)
}

export function toHubScratchlistAttachmentPath(storageKey: string): string {
    return `${HUB_SCRATCHLIST_ATTACHMENT_PATH_PREFIX}${storageKey}`
}

export function parseHubScratchlistAttachmentPath(path: string): string | null {
    if (!isHubScratchlistAttachmentPath(path)) {
        return null
    }
    const key = path.slice(HUB_SCRATCHLIST_ATTACHMENT_PATH_PREFIX.length).trim()
    return key.length > 0 ? key : null
}

export const SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_FILE = 10 * 1024 * 1024
export const SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_PER_ENTRY = 4
export const SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_ENTRY = 20 * 1024 * 1024
export const SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_SESSION = 100 * 1024 * 1024

export const SCRATCHLIST_ATTACHMENT_DEFAULT_ALLOWED_MIMES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
    'text/plain',
] as const

export const ScratchlistAttachmentLimitsSchema = z.object({
    maxBytesPerFile: z.number().int().positive(),
    maxAttachmentsPerEntry: z.number().int().positive(),
    maxBytesPerEntry: z.number().int().positive(),
    maxBytesPerSession: z.number().int().positive(),
    allowedMimeTypes: z.array(z.string().min(1)),
})

export type ScratchlistAttachmentLimits = z.infer<typeof ScratchlistAttachmentLimitsSchema>

export const SCRATCHLIST_ATTACHMENT_DEFAULT_LIMITS: ScratchlistAttachmentLimits = {
    maxBytesPerFile: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_FILE,
    maxAttachmentsPerEntry: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_PER_ENTRY,
    maxBytesPerEntry: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_ENTRY,
    maxBytesPerSession: SCRATCHLIST_ATTACHMENT_DEFAULT_MAX_BYTES_PER_SESSION,
    allowedMimeTypes: [...SCRATCHLIST_ATTACHMENT_DEFAULT_ALLOWED_MIMES],
}

/** Persisted attachment metadata — previewUrl is client-only and stripped at hub write */
export const ScratchlistAttachmentMetadataSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    path: z.string(),
})

export type ScratchlistAttachmentMetadata = z.infer<typeof ScratchlistAttachmentMetadataSchema>

export const ScratchlistAttachmentsArraySchema = z.array(ScratchlistAttachmentMetadataSchema)

export function parseScratchlistAttachmentsJson(raw: string | null | undefined): ScratchlistAttachmentMetadata[] {
    if (!raw) return []
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return []
    }
    const result = ScratchlistAttachmentsArraySchema.safeParse(parsed)
    return result.success ? result.data : []
}

export function serializeScratchlistAttachments(attachments: ScratchlistAttachmentMetadata[]): string | null {
    if (attachments.length === 0) return null
    return JSON.stringify(attachments)
}

export function stripPreviewUrls(
    attachments: Array<{ previewUrl?: string } & ScratchlistAttachmentMetadata>
): ScratchlistAttachmentMetadata[] {
    return attachments.map(({ previewUrl: _preview, ...rest }) => rest)
}
