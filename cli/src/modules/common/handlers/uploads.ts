import { logger } from '@/ui/logger'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { rmSync } from 'node:fs'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { getHapiBlobsDir } from '@/constants/uploadPaths'

interface UploadFileRequest {
    sessionId?: string
    filename: string
    content: string  // base64 encoded
    mimeType: string
}

interface UploadFileResponse {
    success: boolean
    path?: string
    error?: string
}

interface DeleteUploadRequest {
    sessionId?: string
    path: string
}

interface DeleteUploadResponse {
    success: boolean
    error?: string
}

interface MultipartUploadStartRequest {
    sessionId?: string
    filename: string
    mimeType: string
}

interface MultipartUploadStartResponse {
    success: boolean
    uploadId?: string
    error?: string
}

interface MultipartUploadChunkRequest {
    sessionId?: string
    uploadId: string
    chunk: string // base64 encoded
}

interface MultipartUploadChunkResponse {
    success: boolean
    error?: string
}

interface MultipartUploadCompleteRequest {
    sessionId?: string
    uploadId: string
}

interface MultipartUploadCompleteResponse {
    success: boolean
    path?: string
    error?: string
}

interface MultipartUploadAbortRequest {
    sessionId?: string
    uploadId: string
}

interface MultipartUploadAbortResponse {
    success: boolean
    error?: string
}

const uploadDirs = new Map<string, string>()
const uploadDirPromises = new Map<string, Promise<string>>()
const uploadDirCleanupRequested = new Set<string>()
let cleanupRegistered = false
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const multipartUploads = new Map<string, { sessionKey: string; filePath: string; bytesWritten: number }>()

function sanitizeFilename(filename: string): string {
    // Remove path separators and limit length
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 255)

    // If filename is empty after sanitization, use a default
    return sanitized || 'upload'
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

    const safeKey = sanitizeFilename(sessionKey)
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
        const staleUploads = Array.from(multipartUploads.entries())
            .filter(([, value]) => value.sessionKey === sessionKey)
        for (const [uploadId, value] of staleUploads) {
            multipartUploads.delete(uploadId)
            try {
                await rm(value.filePath, { force: true })
            } catch (error) {
                logger.debug('Failed to cleanup multipart upload file:', error)
            }
        }

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
    uploadDirPromises.clear()
    uploadDirCleanupRequested.clear()
    multipartUploads.clear()

    for (const dir of dirs) {
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch (error) {
            logger.debug('Failed to cleanup upload directory on exit:', error)
        }
    }
}

function isPathWithinUploadDir(path: string, sessionId?: string): boolean {
    const sessionKey = getSessionKey(sessionId)
    const resolvedPath = resolve(path)
    const activeDir = uploadDirs.get(sessionKey)
    if (activeDir) {
        const resolvedDir = resolve(activeDir)
        const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`
        return resolvedPath.startsWith(dirPrefix)
    }

    const safeKey = sanitizeFilename(sessionKey)
    const resolvedPrefix = resolve(getHapiBlobsDir(), `${safeKey}-`)
    return resolvedPath.startsWith(resolvedPrefix)
}

export function registerUploadHandlers(rpcHandlerManager: RpcHandlerManager): void {
    if (!cleanupRegistered) {
        cleanupRegistered = true
        process.once('exit', cleanupUploadDirsSync)
    }

    rpcHandlerManager.registerHandler<UploadFileRequest, UploadFileResponse>('uploadFile', async (data) => {
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

            // Add timestamp to avoid collisions
            const timestamp = Date.now()
            const uniqueFilename = `${timestamp}-${sanitizedFilename}`
            const filePath = join(dir, uniqueFilename)

            // Decode base64 content and write to file
            const buffer = Buffer.from(data.content, 'base64')
            if (buffer.length > MAX_UPLOAD_BYTES) {
                return rpcError('File too large (max 50MB)')
            }
            await writeFile(filePath, buffer)

            logger.debug('File uploaded successfully:', filePath)
            return { success: true, path: filePath }
        } catch (error) {
            logger.debug('Failed to upload file:', error)
            return rpcError(getErrorMessage(error, 'Failed to upload file'))
        }
    })

    rpcHandlerManager.registerHandler<DeleteUploadRequest, DeleteUploadResponse>('deleteUpload', async (data) => {
        const path = data?.path?.trim()
        if (!path) {
            return rpcError('Path is required')
        }

        if (!isPathWithinUploadDir(path, data.sessionId)) {
            return rpcError('Invalid upload path')
        }

        try {
            try {
                const resolvedRealPath = await realpath(path)
                if (!isPathWithinUploadDir(resolvedRealPath, data.sessionId)) {
                    return rpcError('Invalid upload path')
                }
            } catch (error) {
                const nodeError = error as NodeJS.ErrnoException
                if (nodeError.code !== 'ENOENT') {
                    logger.debug('Failed to resolve upload realpath:', error)
                    return rpcError('Invalid upload path')
                }
            }

            await rm(path, { force: true })
            return { success: true }
        } catch (error) {
            logger.debug('Failed to delete upload file:', error)
            return rpcError(getErrorMessage(error, 'Failed to delete upload file'))
        }
    })

    rpcHandlerManager.registerHandler<MultipartUploadStartRequest, MultipartUploadStartResponse>('uploadMultipartStart', async (data) => {
        if (!data.filename) {
            return rpcError('Filename is required')
        }

        const sessionKey = getSessionKey(data.sessionId)
        const uploadId = crypto.randomUUID()

        try {
            const dir = await getOrCreateUploadDir(data.sessionId)
            const sanitizedFilename = sanitizeFilename(data.filename)
            const timestamp = Date.now()
            const uniqueFilename = `${timestamp}-${sanitizedFilename}`
            const filePath = join(dir, uniqueFilename)

            await writeFile(filePath, new Uint8Array(0))
            multipartUploads.set(uploadId, { sessionKey, filePath, bytesWritten: 0 })
            return { success: true, uploadId }
        } catch (error) {
            logger.debug('Failed to initialize multipart upload:', error)
            return rpcError(getErrorMessage(error, 'Failed to initialize multipart upload'))
        }
    })

    rpcHandlerManager.registerHandler<MultipartUploadChunkRequest, MultipartUploadChunkResponse>('uploadMultipartChunk', async (data) => {
        const uploadId = data?.uploadId?.trim()
        if (!uploadId) {
            return rpcError('Upload id is required')
        }

        const entry = multipartUploads.get(uploadId)
        if (!entry) {
            return rpcError('Upload not found')
        }

        const requestSessionKey = getSessionKey(data.sessionId)
        if (entry.sessionKey !== requestSessionKey) {
            return rpcError('Upload session mismatch')
        }

        if (!isPathWithinUploadDir(entry.filePath, data.sessionId)) {
            multipartUploads.delete(uploadId)
            return rpcError('Invalid upload path')
        }

        if (!data.chunk) {
            return rpcError('Chunk is required')
        }

        try {
            const buffer = Buffer.from(data.chunk, 'base64')
            const nextSize = entry.bytesWritten + buffer.length
            if (nextSize > MAX_UPLOAD_BYTES) {
                await rm(entry.filePath, { force: true })
                multipartUploads.delete(uploadId)
                return rpcError('File too large (max 50MB)')
            }

            await writeFile(entry.filePath, buffer, { flag: 'a' })
            entry.bytesWritten = nextSize
            return { success: true }
        } catch (error) {
            logger.debug('Failed to append multipart upload chunk:', error)
            return rpcError(getErrorMessage(error, 'Failed to append multipart upload chunk'))
        }
    })

    rpcHandlerManager.registerHandler<MultipartUploadCompleteRequest, MultipartUploadCompleteResponse>('uploadMultipartComplete', async (data) => {
        const uploadId = data?.uploadId?.trim()
        if (!uploadId) {
            return rpcError('Upload id is required')
        }

        const entry = multipartUploads.get(uploadId)
        if (!entry) {
            return rpcError('Upload not found')
        }

        const requestSessionKey = getSessionKey(data.sessionId)
        if (entry.sessionKey !== requestSessionKey) {
            return rpcError('Upload session mismatch')
        }

        multipartUploads.delete(uploadId)
        return { success: true, path: entry.filePath }
    })

    rpcHandlerManager.registerHandler<MultipartUploadAbortRequest, MultipartUploadAbortResponse>('uploadMultipartAbort', async (data) => {
        const uploadId = data?.uploadId?.trim()
        if (!uploadId) {
            return rpcError('Upload id is required')
        }

        const entry = multipartUploads.get(uploadId)
        if (!entry) {
            return { success: true }
        }

        multipartUploads.delete(uploadId)
        try {
            await rm(entry.filePath, { force: true })
            return { success: true }
        } catch (error) {
            logger.debug('Failed to abort multipart upload:', error)
            return rpcError(getErrorMessage(error, 'Failed to abort multipart upload'))
        }
    })
}
