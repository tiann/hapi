import type { ScratchlistAttachmentMetadata } from '@hapi/protocol'

/** Client-only attachment metadata. The preview is never sent to the Hub. */
export type ScratchlistAttachmentWithPreview = ScratchlistAttachmentMetadata & {
    previewUrl?: string
}

type CachedPreview = {
    signature: string
    src: string
    kind: 'data' | 'object-url'
    bytes: number
}

const previews = new Map<string, CachedPreview>()
const MAX_CACHED_PREVIEWS = 64
const MAX_CACHED_PREVIEW_BYTES = 20 * 1024 * 1024
let cachedPreviewBytes = 0

function signature(attachment: ScratchlistAttachmentMetadata): string {
    return [
        attachment.id,
        attachment.filename,
        attachment.mimeType,
        attachment.size,
        attachment.path,
    ].join('\u001f')
}

function revokeIfOwned(preview: CachedPreview | undefined): void {
    if (preview?.kind === 'object-url' && typeof URL !== 'undefined') {
        URL.revokeObjectURL(preview.src)
    }
}

function putPreview(
    attachment: ScratchlistAttachmentMetadata,
    src: string,
    kind: CachedPreview['kind'],
): string {
    const next = {
        signature: signature(attachment),
        src,
        kind,
        bytes: Number.isFinite(attachment.size) ? Math.max(0, attachment.size) : 0,
    } satisfies CachedPreview
    const current = previews.get(attachment.id)
    if (
        current
        && current.signature === next.signature
        && current.src === next.src
    ) {
        return current.src
    }
    revokeIfOwned(current)
    cachedPreviewBytes -= current?.bytes ?? 0
    previews.delete(attachment.id)
    previews.set(attachment.id, next)
    cachedPreviewBytes += next.bytes
    while (previews.size > MAX_CACHED_PREVIEWS || cachedPreviewBytes > MAX_CACHED_PREVIEW_BYTES) {
        const oldest = previews.entries().next().value as [string, CachedPreview] | undefined
        if (!oldest) break
        const [oldestId, oldestPreview] = oldest
        revokeIfOwned(oldestPreview)
        cachedPreviewBytes -= oldestPreview.bytes
        previews.delete(oldestId)
    }
    return next.src
}

/** Remember a preview that already exists in the composer, without fetching it. */
export function rememberScratchlistAttachmentPreview(
    attachment: ScratchlistAttachmentMetadata,
    previewUrl: string | undefined,
): void {
    if (!previewUrl) return
    putPreview(attachment, previewUrl, 'data')
}

/** Resolve a preview from the attachment metadata or this page's memory cache. */
export function getScratchlistAttachmentPreview(
    attachment: ScratchlistAttachmentWithPreview,
): string | undefined {
    if (attachment.previewUrl) return attachment.previewUrl
    const cached = previews.get(attachment.id)
    if (!cached || cached.signature !== signature(attachment)) return undefined
    // Refresh the entry's LRU position whenever a thumbnail is reused.
    previews.delete(attachment.id)
    previews.set(attachment.id, cached)
    return cached.src
}

/** Cache a blob URL downloaded for a thumbnail and prefer an existing data URL. */
export function rememberScratchlistAttachmentObjectUrl(
    attachment: ScratchlistAttachmentMetadata,
    objectUrl: string,
): string {
    const cached = previews.get(attachment.id)
    if (cached?.signature === signature(attachment)) {
        if (cached.kind === 'data') {
            if (typeof URL !== 'undefined') URL.revokeObjectURL(objectUrl)
            return cached.src
        }
        if (cached.src === objectUrl) return cached.src
    }
    return putPreview(attachment, objectUrl, 'object-url')
}

/** Release a preview when its attachment is removed from the scratchlist. */
export function releaseScratchlistAttachmentPreview(attachmentId: string): void {
    const cached = previews.get(attachmentId)
    if (!cached) return
    revokeIfOwned(cached)
    cachedPreviewBytes -= cached.bytes
    previews.delete(attachmentId)
}

/** Test/lifecycle hook; also releases cached blob URLs when a page is discarded. */
export function clearScratchlistAttachmentPreviewCache(): void {
    for (const preview of previews.values()) revokeIfOwned(preview)
    previews.clear()
    cachedPreviewBytes = 0
}
