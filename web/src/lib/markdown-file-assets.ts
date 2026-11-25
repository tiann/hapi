import { classifyScheme } from '@/lib/markdown-uri-policy'
import { hasKnownFileExtension, isKnownSpaHref, isWithinWorkspace } from '@/lib/markdown-href-policy'

export const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024

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
    webp: 'image/webp',
}

export type MarkdownAssetTarget =
    | { kind: 'local'; path: string }
    | { kind: 'remote'; href: string }
    | { kind: 'uri'; href: string }
    | { kind: 'anchor'; href: string }
    | { kind: 'inert'; href: string }

export interface MarkdownAssetResolutionOptions {
    workspacePath?: string | null
}

function decodeHref(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function stripHrefMeta(value: string): string {
    const hashIndex = value.indexOf('#')
    const queryIndex = value.indexOf('?')
    const cut = hashIndex < 0
        ? queryIndex
        : queryIndex < 0
            ? hashIndex
            : Math.min(hashIndex, queryIndex)
    return cut < 0 ? value : value.slice(0, cut)
}

function hasScheme(value: string): boolean {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
}

function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z]:%5[cC]/.test(value)
}

function isAbsolutePath(value: string): boolean {
    return value.startsWith('/') || isWindowsAbsolutePath(value)
}

function normalizeLocalPath(currentFilePath: string, target: string): string | null {
    const current = currentFilePath.replaceAll('\\', '/')
    const rawTarget = target.replaceAll('\\', '/')
    const absolute = rawTarget.startsWith('/') || /^[A-Za-z]:\//.test(rawTarget)
    const currentAbsolute = current.startsWith('/') || /^[A-Za-z]:\//.test(current)
    const baseParts = absolute ? [] : current.split('/').slice(0, -1)
    const targetParts = rawTarget.split('/')
    const parts = absolute ? [] : [...baseParts]
    const rootBoundary = absolute
        ? (/^[A-Za-z]:\//.test(rawTarget) ? 1 : 0)
        : (currentAbsolute ? 1 : 0)

    if (absolute && /^[A-Za-z]:\//.test(rawTarget)) {
        parts.push(rawTarget.slice(0, 2))
        targetParts.shift()
    }

    for (const part of targetParts) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (parts.length <= rootBoundary || (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]!))) {
                return null
            }
            parts.pop()
            continue
        }
        parts.push(part)
    }

    if (parts.length === 0) return absolute ? '/' : null
    const joined = parts.join('/')
    if (absolute && joined.length === 2 && /^[A-Za-z]:$/.test(joined)) return `${joined}/`
    return absolute && !joined.startsWith('/') && !/^[A-Za-z]:/.test(joined)
        ? `/${joined}`
        : joined
}

function classifyTarget(currentFilePath: string, href: string, options: MarkdownAssetResolutionOptions = {}): MarkdownAssetTarget {
    const raw = href.trim()
    if (!raw) return { kind: 'inert', href }
    if (raw.startsWith('#') || raw.startsWith('?')) return { kind: 'anchor', href: raw }
    if (raw.startsWith('//') || /^https?:\/\//i.test(raw)) return { kind: 'remote', href: raw }
    if (hasScheme(raw) && !isWindowsAbsolutePath(raw)) {
        return classifyScheme(raw) === 'deny'
            ? { kind: 'inert', href: raw }
            : { kind: 'uri', href: raw }
    }
    if (isKnownSpaHref(raw)) return { kind: 'anchor', href: raw }

    const decoded = decodeHref(stripHrefMeta(raw))
    if (!decoded || decoded.startsWith('~/')) return { kind: 'inert', href: raw }
    if (!hasKnownFileExtension(decoded) && !getMarkdownImageMimeType(decoded)) return { kind: 'inert', href: raw }

    const absoluteTarget = isAbsolutePath(decoded)
    const absoluteCurrent = isAbsolutePath(currentFilePath)
    if (absoluteTarget && (!options.workspacePath || !isWithinWorkspace(decoded, options.workspacePath))) {
        return { kind: 'inert', href: raw }
    }
    if (absoluteCurrent && !options.workspacePath) {
        return { kind: 'inert', href: raw }
    }

    const path = normalizeLocalPath(currentFilePath, decoded)
    if (!path) return { kind: 'inert', href: raw }
    if (options.workspacePath && isAbsolutePath(path) && !isWithinWorkspace(path, options.workspacePath)) {
        return { kind: 'inert', href: raw }
    }
    return { kind: 'local', path }
}

export function resolveMarkdownFileLink(currentFilePath: string, href: string, options?: MarkdownAssetResolutionOptions): MarkdownAssetTarget {
    return classifyTarget(currentFilePath, href, options)
}

export function resolveMarkdownFileImage(currentFilePath: string, src: string, options?: MarkdownAssetResolutionOptions): MarkdownAssetTarget {
    const target = classifyTarget(currentFilePath, src, options)
    if (target.kind === 'uri' || (target.kind === 'local' && !getMarkdownImageMimeType(target.path))) {
        return { kind: 'inert', href: src }
    }
    return target
}

export function getMarkdownImageMimeType(path: string): string | null {
    const extension = path.split(/[./\\]/).pop()?.toLowerCase()
    return extension ? IMAGE_MIME_BY_EXTENSION[extension] ?? null : null
}
