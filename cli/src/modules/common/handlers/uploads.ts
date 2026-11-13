import { logger } from '@/ui/logger'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, rename, rm, type FileHandle } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { rmSync } from 'node:fs'
import type {
    AbortChunkedUploadResponse,
    DeleteUploadResponse,
    InitChunkedUploadResponse,
    UploadChunkResponse,
    UploadErrorCode,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'
import {
    DEFAULT_UPLOAD_CHUNK_BYTES,
    resolveMaxUploadBytes,
    UPLOAD_CHUNK_MAX_BYTES
} from '@hapi/protocol/apiTypes'
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

interface UploadInitRequest {
    sessionId?: string
    filename: string
    size: number
    mimeType: string
}

interface UploadChunkRequest {
    sessionId?: string
    uploadId: string
    index: number
    content: string  // base64 encoded
}

interface UploadFinalizeRequest {
    sessionId?: string
    uploadId: string
}

interface UploadAbortRequest {
    sessionId?: string
    uploadId: string
}

interface DeleteUploadRequest {
    sessionId?: string
    path: string
}

interface ActiveChunkedUpload {
    uploadId: string
    sessionKey: string
    tempPath: string
    finalPath: string
    totalBytes: number
    receivedBytes: number
    nextIndex: number
    handle: FileHandle
    busy: boolean
    inflightOp: Promise<void> | null
    aborted: boolean
    timer: ReturnType<typeof setTimeout>
}

const uploadDirs = new Map<string, string>()
const uploadFileIdentities = new Map<string, Map<string, string>>()
const uploadDirPromises = new Map<string, Promise<string>>()
const uploadDirCleanupRequested = new Set<string>()
const retainedUploadDirs = new Set<string>()
const activeChunkedUploads = new Map<string, ActiveChunkedUpload>()
let pendingChunkedUploadInits = 0
let cleanupRegistered = false
const MAX_FILENAME_COMPONENT_BYTES = 255
const ACTIVE_UPLOAD_TTL_MS = 15 * 60 * 1000
const MAX_ACTIVE_CHUNKED_UPLOADS = 16

function rpcUploadError(error: string, code: UploadErrorCode): { success: false; error: string; code: UploadErrorCode } {
    return { success: false, error, code }
}

function scheduleUploadExpiration(state: ActiveChunkedUpload, ttlMs: number): void {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
        void abortActiveUpload(state.uploadId)
    }, ttlMs)
    state.timer.unref?.()
}

async function abortActiveUpload(uploadId: string): Promise<void> {
    const state = activeChunkedUploads.get(uploadId)
    if (!state) {
        return
    }
    activeChunkedUploads.delete(uploadId)
    state.aborted = true
    clearTimeout(state.timer)
    if (state.inflightOp) {
        await state.inflightOp.catch(() => {})
    }
    await state.handle.close().catch(() => {})
    await rm(state.tempPath, { force: true }).catch(() => {})
}

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
    retainedUploadDirs.delete(sessionKey)
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

        const activeUploadIds = Array.from(activeChunkedUploads.values())
            .filter((state) => state.sessionKey === sessionKey)
            .map((state) => state.uploadId)
        if (activeUploadIds.length > 0) {
            await Promise.all(activeUploadIds.map((uploadId) => abortActiveUpload(uploadId)))
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

/** Pending native input still references these temporary files after suspension.
 * Explicit cleanup still removes them; otherwise normal OS temp cleanup applies. */
export function preserveUploadDirOnExit(sessionId: string): void {
    retainedUploadDirs.add(getSessionKey(sessionId))
}

function cleanupUploadDirsSync(): void {
    const dirs = Array.from(uploadDirs.entries()).filter(([key]) => !retainedUploadDirs.has(key)).map(([, dir]) => dir)
    pendingChunkedUploadInits = 0
    for (const state of activeChunkedUploads.values()) {
        clearTimeout(state.timer)
        state.aborted = true
        if (!retainedUploadDirs.has(state.sessionKey)) {
            void state.handle.close().catch(() => {})
        }
    }
    activeChunkedUploads.clear()
    uploadDirs.clear()
    uploadFileIdentities.clear()
    uploadDirPromises.clear()
    uploadDirCleanupRequested.clear()
    retainedUploadDirs.clear()

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

function buildUniqueUploadFilename(filename: string, reserveSuffixBytes: number = 0): string {
    const sanitizedFilename = sanitizeFilename(filename)
    const timestamp = Date.now()
    const prefix = `${timestamp}-${randomUUID()}-`
    const boundedFilename = fitFilenameToBytes(
        sanitizedFilename,
        MAX_FILENAME_COMPONENT_BYTES - Buffer.byteLength(prefix) - reserveSuffixBytes,
    )
    return `${prefix}${boundedFilename}`
}

export function registerUploadHandlers(
    rpcHandlerManager: RpcHandlerManager,
    options?: { activeUploadTtlMs?: number }
): void {
    const activeUploadTtlMs = options?.activeUploadTtlMs ?? ACTIVE_UPLOAD_TTL_MS
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
            const uniqueFilename = buildUniqueUploadFilename(data.filename)
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

    rpcHandlerManager.registerHandler<UploadInitRequest, InitChunkedUploadResponse>(RPC_METHODS.UploadInit, async (data) => {
        if (!data?.filename) {
            return rpcUploadError('Filename is required', 'upload_invalid_chunk')
        }
        if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0) {
            return rpcUploadError('Valid file size is required', 'upload_invalid_chunk')
        }

        const maxUploadBytes = resolveMaxUploadBytes(process.env.HAPI_MAX_UPLOAD_BYTES)
        if (data.size > maxUploadBytes) {
            return rpcUploadError(
                `File too large (max ${Math.floor(maxUploadBytes / (1024 * 1024))}MB)`,
                'upload_too_large'
            )
        }

        if (activeChunkedUploads.size + pendingChunkedUploadInits >= MAX_ACTIVE_CHUNKED_UPLOADS) {
            return rpcUploadError('Too many concurrent uploads', 'upload_conflict')
        }

        const sessionKey = getSessionKey(data.sessionId)
        pendingChunkedUploadInits += 1
        try {
            const dir = await getOrCreateUploadDir(data.sessionId)
            const uniqueFilename = buildUniqueUploadFilename(data.filename, Buffer.byteLength('.part'))
            const finalPath = join(dir, uniqueFilename)
            const tempPath = `${finalPath}.part`
            const handle = await open(tempPath, 'wx', 0o600)

            if (uploadDirCleanupRequested.has(sessionKey)) {
                await handle.close().catch(() => {})
                await rm(tempPath, { force: true }).catch(() => {})
                return rpcUploadError('Upload directory cleanup requested', 'upload_conflict')
            }

            const uploadId = randomUUID()
            const state: ActiveChunkedUpload = {
                uploadId,
                sessionKey,
                tempPath,
                finalPath,
                totalBytes: data.size,
                receivedBytes: 0,
                nextIndex: 0,
                handle,
                busy: false,
                inflightOp: null,
                aborted: false,
                timer: setTimeout(() => {
                    void abortActiveUpload(uploadId)
                }, activeUploadTtlMs),
            }
            state.timer.unref?.()
            activeChunkedUploads.set(uploadId, state)

            return {
                success: true,
                uploadId,
                chunkSize: DEFAULT_UPLOAD_CHUNK_BYTES,
                maxUploadBytes,
            }
        } catch (error) {
            logger.debug('Failed to initialize chunked upload:', error)
            return rpcError(getErrorMessage(error, 'Failed to initialize upload'))
        } finally {
            pendingChunkedUploadInits = Math.max(0, pendingChunkedUploadInits - 1)
        }
    })

    rpcHandlerManager.registerHandler<UploadChunkRequest, UploadChunkResponse>(RPC_METHODS.UploadChunk, async (data) => {
        if (!data?.uploadId) {
            return rpcUploadError('uploadId is required', 'upload_invalid_chunk')
        }
        const sessionKey = getSessionKey(data.sessionId)
        const state = activeChunkedUploads.get(data.uploadId)
        if (!state || state.aborted || state.sessionKey !== sessionKey) {
            return rpcUploadError('Upload not found', 'upload_not_found')
        }
        if (state.busy) {
            return rpcUploadError('Upload operation already in progress', 'upload_conflict')
        }
        if (typeof data.index !== 'number' || !Number.isSafeInteger(data.index) || data.index !== state.nextIndex) {
            return rpcUploadError(`Expected chunk index ${state.nextIndex}, got ${String(data.index)}`, 'upload_invalid_chunk')
        }
        if (typeof data.content !== 'string' || data.content.length === 0) {
            return rpcUploadError('Chunk content is required', 'upload_invalid_chunk')
        }
        if (estimateBase64Bytes(data.content) > UPLOAD_CHUNK_MAX_BYTES) {
            return rpcUploadError('Chunk exceeds maximum size (8MB)', 'upload_chunk_too_large')
        }

        const buffer = Buffer.from(data.content, 'base64')
        if (buffer.length === 0) {
            return rpcUploadError('Chunk content is invalid', 'upload_invalid_chunk')
        }
        if (buffer.length > UPLOAD_CHUNK_MAX_BYTES) {
            return rpcUploadError('Chunk exceeds maximum size (8MB)', 'upload_chunk_too_large')
        }
        if (state.receivedBytes + buffer.length > state.totalBytes) {
            await abortActiveUpload(state.uploadId)
            return rpcUploadError('Uploaded bytes exceed declared file size', 'upload_size_mismatch')
        }

        state.busy = true
        scheduleUploadExpiration(state, activeUploadTtlMs)
        const writeOffset = state.receivedBytes
        const op = (async () => {
            let written = 0
            while (written < buffer.length) {
                const result = await state.handle.write(buffer, written, buffer.length - written, writeOffset + written)
                if (result.bytesWritten <= 0) {
                    throw new Error('Failed to write upload chunk')
                }
                written += result.bytesWritten
            }
        })()
        state.inflightOp = op

        try {
            await op
            if (state.aborted || activeChunkedUploads.get(state.uploadId) !== state) {
                return rpcUploadError('Upload aborted', 'upload_not_found')
            }
            state.receivedBytes += buffer.length
            state.nextIndex += 1
            return { success: true, receivedBytes: state.receivedBytes }
        } catch (error) {
            logger.debug('Failed to write upload chunk:', error)
            await abortActiveUpload(state.uploadId)
            return rpcError(getErrorMessage(error, 'Failed to write upload chunk'))
        } finally {
            state.inflightOp = null
            state.busy = false
        }
    })

    rpcHandlerManager.registerHandler<UploadFinalizeRequest, UploadFileResponse>(RPC_METHODS.UploadFinalize, async (data) => {
        if (!data?.uploadId) {
            return rpcUploadError('uploadId is required', 'upload_invalid_chunk')
        }
        const sessionKey = getSessionKey(data.sessionId)
        const state = activeChunkedUploads.get(data.uploadId)
        if (!state || state.aborted || state.sessionKey !== sessionKey) {
            return rpcUploadError('Upload not found', 'upload_not_found')
        }
        if (state.busy) {
            return rpcUploadError('Upload operation already in progress', 'upload_conflict')
        }
        if (state.receivedBytes !== state.totalBytes) {
            return rpcUploadError(
                `Incomplete upload: received ${state.receivedBytes} of ${state.totalBytes} bytes`,
                'upload_incomplete'
            )
        }

        activeChunkedUploads.delete(state.uploadId)
        clearTimeout(state.timer)
        state.busy = true

        const finalizeOp = (async (): Promise<UploadFileResponse> => {
            await state.handle.close()
            await rename(state.tempPath, state.finalPath)
            const info = await lstat(state.finalPath)
            if (!info.isFile() || info.size !== state.totalBytes || state.aborted || uploadDirCleanupRequested.has(sessionKey)) {
                await rm(state.finalPath, { force: true }).catch(() => {})
                if (info.isFile() && info.size !== state.totalBytes) {
                    return rpcUploadError('Finalized upload size mismatch', 'upload_size_mismatch')
                }
                return rpcUploadError('Upload aborted during finalization', 'upload_conflict')
            }
            const files = uploadFileIdentities.get(sessionKey) ?? new Map<string, string>()
            files.set(resolve(state.finalPath), uploadIdentityKey(info))
            uploadFileIdentities.set(sessionKey, files)
            logger.debug('Chunked file uploaded successfully:', state.finalPath)
            return { success: true, path: state.finalPath }
        })()

        state.inflightOp = finalizeOp.then(() => undefined, () => undefined)

        try {
            return await finalizeOp
        } catch (error) {
            logger.debug('Failed to finalize chunked upload:', error)
            await rm(state.tempPath, { force: true }).catch(() => {})
            await rm(state.finalPath, { force: true }).catch(() => {})
            return rpcError(getErrorMessage(error, 'Failed to finalize upload'))
        } finally {
            state.inflightOp = null
            state.busy = false
        }
    })

    rpcHandlerManager.registerHandler<UploadAbortRequest, AbortChunkedUploadResponse>(RPC_METHODS.UploadAbort, async (data) => {
        if (!data?.uploadId) {
            return rpcUploadError('uploadId is required', 'upload_invalid_chunk')
        }
        const state = activeChunkedUploads.get(data.uploadId)
        if (!state) {
            return { success: true }
        }
        if (state.sessionKey !== getSessionKey(data.sessionId)) {
            return rpcUploadError('Upload not found', 'upload_not_found')
        }
        await abortActiveUpload(state.uploadId)
        return { success: true }
    })
}
