import { logger } from '@/ui/logger'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, rm } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { rmSync } from 'node:fs'
import type { DeleteUploadResponse, UploadFileResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { getHapiBlobsDir } from '@/constants/uploadPaths'
import { MAX_UPLOAD_BYTES } from '../attachmentLimits'

interface UploadFileRequest {
    sessionId?: string
    filename: string
    content: string  // base64 encoded
    mimeType: string
}

interface DeleteUploadRequest {
    sessionId?: string
    path: string
}

const uploadDirs = new Map<string, string>()
const uploadFileIdentities = new Map<string, Map<string, string>>()
const uploadDirPromises = new Map<string, Promise<string>>()
const uploadDirCleanupRequested = new Set<string>()
let cleanupRegistered = false
const MAX_FILENAME_COMPONENT_BYTES = 255

export type UploadFileIdentity = { dev: number; ino: number }

function uploadIdentityKey(identity: UploadFileIdentity): string {
    return `${identity.dev}:${identity.ino}`
}

export function isAuthorizedUploadFile(path: string, sessionId: string | undefined, identity: UploadFileIdentity): boolean {
    return uploadFileIdentities.get(getSessionKey(sessionId))?.get(resolve(path)) === uploadIdentityKey(identity)
}

function sanitizeFilename(filename: string): string {
    // Remove path separators; byte-safe length fitting happens after the
    // unique prefix is known so the original extension can be preserved.
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/\s+/g, '_')

    // If filename is empty after sanitization, use a default
    return sanitized || 'upload'
}

function truncateUtf8(text: string, maxBytes: number): string {
    let result = ''
    let bytes = 0
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character)
        if (bytes + characterBytes > maxBytes) break
        result += character
        bytes += characterBytes
    }
    return result
}

function fitFilenameToBytes(filename: string, maxBytes: number): string {
    const extension = extname(filename)
    const extensionBytes = Buffer.byteLength(extension)
    if (extension && extensionBytes <= maxBytes) {
        const stem = filename.slice(0, -extension.length)
        return `${truncateUtf8(stem, maxBytes - extensionBytes)}${extension}`
    }
    return truncateUtf8(filename, maxBytes) || 'upload'
}

function getSessionKey(sessionId?: string): string {
    const trimmed = sessionId?.trim()
    return trimmed ? trimmed : 'unknown'
}

function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

async function getOrCreateUploadDir(sessionId?: string): Promise<string> {
    const sessionKey = getSessionKey(sessionId)
    const existing = uploadDirs.get(sessionKey)
    if (existing) {
        return existing
    }

    const inflight = uploadDirPromises.get(sessionKey)
    if (inflight) {
        return await inflight
    }

    const safeKey = fitFilenameToBytes(sanitizeFilename(sessionKey), 120)
    const creation = (async () => {
        try {
            const blobsDir = getHapiBlobsDir()
            await mkdir(blobsDir, { recursive: true })
            const dir = await mkdtemp(join(blobsDir, `${safeKey}-`))
            if (uploadDirCleanupRequested.has(sessionKey)) {
                try {
                    await rm(dir, { recursive: true, force: true })
                } catch (error) {
                    logger.debug('Failed to cleanup upload directory after cancel:', error)
                }
                throw new Error('Upload directory cleanup requested')
            }
            uploadDirs.set(sessionKey, dir)
            return dir
        } finally {
            uploadDirPromises.delete(sessionKey)
        }
    })()
    uploadDirPromises.set(sessionKey, creation)
    return await creation
}

export async function cleanupUploadDir(sessionId?: string): Promise<void> {
    const sessionKey = getSessionKey(sessionId)
    uploadDirCleanupRequested.add(sessionKey)

    try {
        const inflight = uploadDirPromises.get(sessionKey)
        if (inflight) {
            try {
                await inflight
            } catch {
                // ignore inflight errors
            }
        }

        const dir = uploadDirs.get(sessionKey)
        uploadDirs.delete(sessionKey)
        uploadFileIdentities.delete(sessionKey)
        uploadDirPromises.delete(sessionKey)

        if (!dir) {
            return
        }

        try {
            await rm(dir, { recursive: true, force: true })
        } catch (error) {
            logger.debug('Failed to cleanup upload directory:', error)
        }
    } finally {
        uploadDirCleanupRequested.delete(sessionKey)
    }
}

function cleanupUploadDirsSync(): void {
    const dirs = Array.from(uploadDirs.values())
    uploadDirs.clear()
    uploadFileIdentities.clear()
    uploadDirPromises.clear()
    uploadDirCleanupRequested.clear()

    for (const dir of dirs) {
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch (error) {
            logger.debug('Failed to cleanup upload directory on exit:', error)
        }
    }
}

export function isPathWithinUploadDir(path: string, sessionId?: string): boolean {
    const sessionKey = getSessionKey(sessionId)
    const resolvedPath = resolve(path)
    const activeDir = uploadDirs.get(sessionKey)
    if (activeDir) {
        const resolvedDir = resolve(activeDir)
        const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`
        return resolvedPath.startsWith(dirPrefix)
    }

    const safeKey = fitFilenameToBytes(sanitizeFilename(sessionKey), 120)
    const resolvedPrefix = resolve(getHapiBlobsDir(), `${safeKey}-`)
    return resolvedPath.startsWith(resolvedPrefix)
}

export function registerUploadHandlers(rpcHandlerManager: RpcHandlerManager): void {
    if (!cleanupRegistered) {
        cleanupRegistered = true
        process.once('exit', cleanupUploadDirsSync)
    }

    rpcHandlerManager.registerHandler<UploadFileRequest, UploadFileResponse>(RPC_METHODS.UploadFile, async (data) => {
        logger.debug('Upload file request:', data.filename, 'mimeType:', data.mimeType)

        if (!data.filename) {
            return rpcError('Filename is required')
        }

        if (!data.content) {
            return rpcError('Content is required')
        }

        try {
            const estimatedBytes = estimateBase64Bytes(data.content)
            if (estimatedBytes > MAX_UPLOAD_BYTES) {
                return rpcError('File too large (max 50MB)')
            }

            const dir = await getOrCreateUploadDir(data.sessionId)
            const sanitizedFilename = sanitizeFilename(data.filename)

            // Combine a readable timestamp with a random suffix so concurrent
            // uploads of the same filename remain compatible with exclusive create.
            const timestamp = Date.now()
            const prefix = `${timestamp}-${randomUUID()}-`
            const boundedFilename = fitFilenameToBytes(
                sanitizedFilename,
                MAX_FILENAME_COMPONENT_BYTES - Buffer.byteLength(prefix),
            )
            const uniqueFilename = `${prefix}${boundedFilename}`
            const filePath = join(dir, uniqueFilename)

            // Decode base64 content and write to file
            const buffer = Buffer.from(data.content, 'base64')
            if (buffer.length > MAX_UPLOAD_BYTES) {
                return rpcError('File too large (max 50MB)')
            }
            const file = await open(filePath, 'wx', 0o600)
            let operationError: unknown
            try {
                await file.writeFile(buffer)
                const info = await file.stat()
                const files = uploadFileIdentities.get(getSessionKey(data.sessionId)) ?? new Map<string, string>()
                files.set(resolve(filePath), uploadIdentityKey(info))
                uploadFileIdentities.set(getSessionKey(data.sessionId), files)
            } catch (error) {
                operationError = error
            }
            let closeError: unknown
            try {
                await file.close()
            } catch (error) {
                closeError = error
            }
            if (operationError || closeError) {
                uploadFileIdentities.get(getSessionKey(data.sessionId))?.delete(resolve(filePath))
                await rm(filePath, { force: true }).catch(() => {})
                throw operationError ?? closeError
            }

            logger.debug('File uploaded successfully:', filePath)
            return { success: true, path: filePath }
        } catch (error) {
            logger.debug('Failed to upload file:', error)
            return rpcError(getErrorMessage(error, 'Failed to upload file'))
        }
    })

    rpcHandlerManager.registerHandler<DeleteUploadRequest, DeleteUploadResponse>(RPC_METHODS.DeleteUpload, async (data) => {
        const path = data?.path?.trim()
        if (!path) {
            return rpcError('Path is required')
        }

        if (!isPathWithinUploadDir(path, data.sessionId)) {
            return rpcError('Invalid upload path')
        }

        try {
            await rm(path, { force: true })
            uploadFileIdentities.get(getSessionKey(data.sessionId))?.delete(resolve(path))
            return { success: true }
        } catch (error) {
            logger.debug('Failed to delete upload file:', error)
            return rpcError(getErrorMessage(error, 'Failed to delete upload file'))
        }
    })
}
