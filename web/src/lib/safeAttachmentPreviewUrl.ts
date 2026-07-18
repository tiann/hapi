const ACTIVE_CONTENT_MIME_TYPES = new Set([
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml'
])

const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

function normalizeMimeType(value: string): string {
    return value
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase() ?? ''
}

function getBase64DataUrlMimeType(value: string): string | null {
    const match = /^data:([^;,]+);base64,/i.exec(value)
    if (!match) return null

    const mediaType = normalizeMimeType(match[1])
    if (!mediaType || !MIME_TYPE_PATTERN.test(mediaType)) return null
    return mediaType
}

export function isSafeAttachmentPreviewUrl(value: unknown, attachmentMimeType: unknown): value is string {
    if (typeof value !== 'string' || typeof attachmentMimeType !== 'string') return false

    const urlMimeType = getBase64DataUrlMimeType(value)
    if (!urlMimeType) return false

    const normalizedAttachmentMimeType = normalizeMimeType(attachmentMimeType)
    if (!normalizedAttachmentMimeType || urlMimeType !== normalizedAttachmentMimeType) return false

    return !ACTIVE_CONTENT_MIME_TYPES.has(urlMimeType)
}

export function getSafeAttachmentPreviewUrl(value: unknown, attachmentMimeType: unknown): string | undefined {
    return isSafeAttachmentPreviewUrl(value, attachmentMimeType) ? value : undefined
}
