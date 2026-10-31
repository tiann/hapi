export type MarkdownPreviewMode = 'source' | 'preview'

export const MARKDOWN_PREVIEW_MODE_STORAGE_KEY = 'hapi.filePreview.markdownMode.v1'
export const DEFAULT_MARKDOWN_PREVIEW_MODE: MarkdownPreviewMode = 'preview'

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp'
}

export function resolveImageMimeType(path: string): string | null {
    const parts = path.split('.')
    if (parts.length <= 1) return null
    const ext = parts[parts.length - 1]?.toLowerCase()
    if (!ext) return null
    return IMAGE_MIME_BY_EXTENSION[ext] ?? null
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) {
        return null
    }
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) {
        return
    }
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) {
        return
    }
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

export function isMarkdownFile(path: string): boolean {
    const parts = path.split('.')
    if (parts.length <= 1) {
        return false
    }
    const ext = parts[parts.length - 1]?.toLowerCase()
    return ext === 'md' || ext === 'mdx'
}

function parseMarkdownPreviewMode(raw: string | null): MarkdownPreviewMode {
    if (raw === 'source' || raw === 'preview') {
        return raw
    }
    return DEFAULT_MARKDOWN_PREVIEW_MODE
}

export function getInitialMarkdownPreviewMode(): MarkdownPreviewMode {
    return parseMarkdownPreviewMode(safeGetItem(MARKDOWN_PREVIEW_MODE_STORAGE_KEY))
}

export function persistMarkdownPreviewMode(mode: MarkdownPreviewMode): void {
    if (mode === DEFAULT_MARKDOWN_PREVIEW_MODE) {
        safeRemoveItem(MARKDOWN_PREVIEW_MODE_STORAGE_KEY)
        return
    }
    safeSetItem(MARKDOWN_PREVIEW_MODE_STORAGE_KEY, mode)
}
