import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ScratchlistAttachmentMetadata } from '@hapi/protocol'
import {
    toHubScratchlistAttachmentPath,
    parseHubScratchlistAttachmentPath,
} from '@hapi/protocol'

function sanitizeFilename(filename: string): string {
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
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
