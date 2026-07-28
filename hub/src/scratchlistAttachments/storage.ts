import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ScratchlistAttachmentMetadata } from '@hapi/protocol'
import {
    toHubScratchlistAttachmentPath,
    parseHubScratchlistAttachmentPath,
} from '@hapi/protocol'

function sanitizeFilename(filename: string): string {
    // Strip path tricks and Content-Disposition hazards (CR/LF/quotes/controls).
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/[\r\n\0"\\]/g, '_')
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 255)
    return sanitized || 'upload'
}

function sanitizeSegment(segment: string): string {
    return segment.replace(/[/\\]/g, '_').replace(/\.\./g, '_').slice(0, 128)
}

export function getHapiHomeDir(): string {
    return process.env.HAPI_HOME || join(homedir(), '.hapi')
}

export function getScratchlistAttachmentsRoot(hapiHome: string = getHapiHomeDir()): string {
    return join(hapiHome, 'scratchlist-attachments')
}

export function buildScratchlistStorageKey(
    namespace: string,
    sessionId: string,
    attachmentId: string,
    filename: string
): string {
    return `${sanitizeSegment(namespace)}/${sanitizeSegment(sessionId)}/${attachmentId}-${sanitizeFilename(filename)}`
}

export function resolveScratchlistStoragePath(hapiHome: string, storageKey: string): string {
    const root = resolve(getScratchlistAttachmentsRoot(hapiHome))
    const resolved = resolve(root, storageKey)
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`
    if (!resolved.startsWith(prefix)) {
        throw new Error('Invalid scratchlist attachment path')
    }
    return resolved
}

export async function writeScratchlistAttachmentFile(
    hapiHome: string,
    namespace: string,
    sessionId: string,
    filename: string,
    mimeType: string,
    buffer: Buffer,
    attachmentId: string = randomUUID()
): Promise<ScratchlistAttachmentMetadata> {
    const storageKey = buildScratchlistStorageKey(namespace, sessionId, attachmentId, filename)
    const filePath = resolveScratchlistStoragePath(hapiHome, storageKey)
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, buffer)
    return {
        id: attachmentId,
        filename: sanitizeFilename(filename),
        mimeType,
        size: buffer.length,
        path: toHubScratchlistAttachmentPath(storageKey),
    }
}

export async function readScratchlistAttachmentFile(
    hapiHome: string,
    hubPath: string
): Promise<{ buffer: Buffer; metadataPath: string } | null> {
    const storageKey = parseHubScratchlistAttachmentPath(hubPath)
    if (!storageKey) return null
    const filePath = resolveScratchlistStoragePath(hapiHome, storageKey)
    try {
        const buffer = await readFile(filePath)
        return { buffer, metadataPath: filePath }
    } catch {
        return null
    }
}

export async function deleteScratchlistAttachmentFile(
    hapiHome: string,
    hubPath: string
): Promise<boolean> {
    const storageKey = parseHubScratchlistAttachmentPath(hubPath)
    if (!storageKey) return false
    const filePath = resolveScratchlistStoragePath(hapiHome, storageKey)
    try {
        await rm(filePath, { force: true })
        return true
    } catch {
        return false
    }
}

export async function deleteScratchlistAttachmentFiles(
    hapiHome: string,
    attachments: ScratchlistAttachmentMetadata[]
): Promise<void> {
    await Promise.all(attachments.map((att) => deleteScratchlistAttachmentFile(hapiHome, att.path)))
}

/**
 * Re-key hub attachment files when a scratchlist row is transferred to a new
 * session id (merge/dedup). Paths embed the session id; without this step
 * quota sums miss the bytes and resolve rejects the path as out-of-session.
 * If the destination file already exists, keep it and delete the source
 * (same "target wins" rule as SQL transfer collisions).
 */
export async function moveScratchlistAttachmentFilesForSession(
    hapiHome: string,
    namespace: string,
    oldSessionId: string,
    newSessionId: string,
    attachments: ScratchlistAttachmentMetadata[]
): Promise<ScratchlistAttachmentMetadata[]> {
    if (oldSessionId === newSessionId || attachments.length === 0) {
        return attachments
    }
    const oldPrefix = sessionStoragePrefix(namespace, oldSessionId)
    const newPrefix = sessionStoragePrefix(namespace, newSessionId)
    const moved: ScratchlistAttachmentMetadata[] = []
    for (const att of attachments) {
        const storageKey = parseHubScratchlistAttachmentPath(att.path)
        if (!storageKey || !storageKey.startsWith(oldPrefix)) {
            moved.push(att)
            continue
        }
        const fileName = storageKey.slice(oldPrefix.length)
        const newKey = `${newPrefix}${fileName}`
        let oldPath: string
        let newPath: string
        try {
            oldPath = resolveScratchlistStoragePath(hapiHome, storageKey)
            newPath = resolveScratchlistStoragePath(hapiHome, newKey)
        } catch {
            moved.push(att)
            continue
        }
        await mkdir(join(newPath, '..'), { recursive: true })
        try {
            const destExists = await stat(newPath).then((info) => info.isFile()).catch(() => false)
            if (destExists) {
                await rm(oldPath, { force: true })
            } else {
                await rename(oldPath, newPath)
            }
        } catch {
            // best effort — still rewrite metadata so quota/resolve use the new id
        }
        moved.push({
            ...att,
            path: toHubScratchlistAttachmentPath(newKey),
        })
    }
    return moved
}

export async function deleteScratchlistSessionAttachmentDir(
    hapiHome: string,
    namespace: string,
    sessionId: string
): Promise<void> {
    const dir = resolveScratchlistStoragePath(
        hapiHome,
        `${sanitizeSegment(namespace)}/${sanitizeSegment(sessionId)}`
    )
    try {
        await rm(dir, { recursive: true, force: true })
    } catch {
        // best effort
    }
}

export function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

function sessionStoragePrefix(namespace: string, sessionId: string): string {
    return `${sanitizeSegment(namespace)}/${sanitizeSegment(sessionId)}/`
}

/**
 * Sum bytes of all files already written under the session's scratchlist
 * attachment directory (includes pending uploads not yet referenced by an entry).
 */
export async function sumScratchlistAttachmentBytesOnDisk(
    hapiHome: string,
    namespace: string,
    sessionId: string
): Promise<number> {
    const dir = resolveScratchlistStoragePath(
        hapiHome,
        `${sanitizeSegment(namespace)}/${sanitizeSegment(sessionId)}`
    )
    let total = 0
    try {
        const names = await readdir(dir)
        for (const name of names) {
            try {
                const info = await stat(join(dir, name))
                if (info.isFile()) {
                    total += info.size
                }
            } catch {
                // skip unreadable entries
            }
        }
    } catch {
        return 0
    }
    return total
}

export const SCRATCHLIST_ATTACHMENT_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Verify claimed metadata points at a hub file owned by this namespace/session,
 * then return server-authoritative metadata (size from disk).
 */
export async function resolveScratchlistAttachmentForSession(
    hapiHome: string,
    namespace: string,
    sessionId: string,
    claimed: ScratchlistAttachmentMetadata
): Promise<
    | { ok: true; attachment: ScratchlistAttachmentMetadata }
    | { ok: false; error: string }
> {
    if (!SCRATCHLIST_ATTACHMENT_ID_RE.test(claimed.id)) {
        return { ok: false, error: 'Invalid scratchlist attachment id' }
    }
    const storageKey = parseHubScratchlistAttachmentPath(claimed.path)
    if (!storageKey) {
        return { ok: false, error: 'Invalid scratchlist attachment path' }
    }
    const expectedPrefix = sessionStoragePrefix(namespace, sessionId)
    if (!storageKey.startsWith(expectedPrefix)) {
        return { ok: false, error: 'Attachment path is outside this session' }
    }
    const fileName = storageKey.slice(expectedPrefix.length)
    if (!fileName.startsWith(`${claimed.id}-`)) {
        return { ok: false, error: 'Attachment id does not match stored file' }
    }
    let filePath: string
    try {
        filePath = resolveScratchlistStoragePath(hapiHome, storageKey)
    } catch {
        return { ok: false, error: 'Invalid scratchlist attachment path' }
    }
    try {
        const info = await stat(filePath)
        if (!info.isFile()) {
            return { ok: false, error: 'Attachment file missing' }
        }
        return {
            ok: true,
            attachment: {
                id: claimed.id,
                // Canonicalize from the on-disk key (already sanitized at write).
                // Never trust claimed.filename for Content-Disposition later.
                filename: sanitizeFilename(fileName.slice(`${claimed.id}-`.length)),
                mimeType: claimed.mimeType,
                size: info.size,
                path: toHubScratchlistAttachmentPath(storageKey),
            },
        }
    } catch {
        return { ok: false, error: 'Attachment file missing' }
    }
}

export async function resolveScratchlistAttachmentsForSession(
    hapiHome: string,
    namespace: string,
    sessionId: string,
    claimed: ScratchlistAttachmentMetadata[]
): Promise<
    | { ok: true; attachments: ScratchlistAttachmentMetadata[] }
    | { ok: false; error: string }
> {
    const resolved: ScratchlistAttachmentMetadata[] = []
    for (const item of claimed) {
        const result = await resolveScratchlistAttachmentForSession(hapiHome, namespace, sessionId, item)
        if (!result.ok) {
            return result
        }
        resolved.push(result.attachment)
    }
    return { ok: true, attachments: resolved }
}

/** Delete a pending/orphan upload by attachment id from the session directory. */
export async function deleteScratchlistAttachmentById(
    hapiHome: string,
    namespace: string,
    sessionId: string,
    attachmentId: string
): Promise<boolean> {
    // Require a full UUID so a partial first-segment like "a1b2c3d4" cannot
    // startsWith-match `${uuid}-${filename}` and delete a still-referenced file.
    if (!SCRATCHLIST_ATTACHMENT_ID_RE.test(attachmentId)) {
        return false
    }
    const dir = resolveScratchlistStoragePath(
        hapiHome,
        `${sanitizeSegment(namespace)}/${sanitizeSegment(sessionId)}`
    )
    try {
        const names = await readdir(dir)
        const prefix = `${attachmentId}-`
        const match = names.find((name) => name.startsWith(prefix))
        if (!match) return false
        await rm(join(dir, match), { force: true })
        return true
    } catch {
        return false
    }
}
