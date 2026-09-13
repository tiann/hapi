import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { lookupMimeType } from './mime'

/**
 * Path-safety helpers for static preview mounts. The browser-controlled
 * sub-path must never escape the mount root, including via symlinks.
 */

export interface ResolvedStaticPath {
    /** Absolute path inside the mount root (not symlink-resolved). */
    absolutePath: string
    /** Whether the URL sub-path ended with `/` (or was empty). */
    trailingSlash: boolean
    mimeType: string
}

/**
 * Validates and resolves a raw (still percent-encoded) URL sub-path against the
 * mount root. Rejects NUL bytes, encoded slashes that decode into separators
 * across segments, `.`/`..`, and every dotfile/dot-directory segment.
 */
export function resolveSubPath(rootPath: string, rawSub: string): ResolvedStaticPath | null {
    if (rawSub.includes('\0')) return null
    const trailingSlash = rawSub === '' || rawSub.endsWith('/')
    let segments: string[]
    try {
        segments = rawSub
            .split('/')
            .filter((segment) => segment.length > 0)
            .map((segment) => decodeURIComponent(segment))
    } catch {
        // Malformed escape sequences — never guess.
        return null
    }
    for (const segment of segments) {
        if (segment === '.' || segment === '..' || segment.startsWith('.') || segment.includes('\0') || segment.includes('/') || segment.includes('\\')) {
            return null
        }
    }
    const absolutePath = resolve(rootPath, ...segments)
    return {
        absolutePath,
        trailingSlash,
        mimeType: lookupMimeType(absolutePath)
    }
}

/** Prefix containment check on already-resolved absolute paths. */
export function isInsideRoot(rootPath: string, absolutePath: string): boolean {
    const root = resolve(rootPath)
    const target = resolve(absolutePath)
    return target === root || target.startsWith(root + sep)
}

/**
 * Symlink-hardened containment: resolves the real root and the real target and
 * requires the target to still live inside the real root.
 */
export async function isRealpathInsideRoot(rootPath: string, absolutePath: string): Promise<boolean> {
    try {
        const [realRoot, realTarget] = await Promise.all([realpath(rootPath), realpath(absolutePath)])
        return isInsideRoot(realRoot, realTarget)
    } catch {
        return false
    }
}
