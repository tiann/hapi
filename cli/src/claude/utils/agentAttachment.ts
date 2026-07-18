import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, parse, relative, resolve, win32 } from 'node:path'
import type { AttachmentMetadata } from '@hapi/protocol/types'

export type AgentAttachmentFileInput = {
    path: string
    filename?: string
    mimeType?: string
}

export const MAX_AGENT_ATTACHMENT_FILES = 3
// Keep raw generated attachments to 30MB total; hub Socket.IO allows base64 transport headroom.
export const MAX_AGENT_ATTACHMENT_TOTAL_BYTES = 30 * 1024 * 1024
const MAX_AGENT_ATTACHMENT_READ_CHUNK_BYTES = 64 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
    '.avif': 'image/avif',
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.zip': 'application/zip'
}

const ACTIVE_CONTENT_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.xhtml'])
const ACTIVE_CONTENT_MIME_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml'])
const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx'])
const SENSITIVE_BASENAMES = new Set(['.npmrc', '.netrc', 'kubeconfig'])
const SENSITIVE_PATH_SEGMENTS = new Set(['.aws', '.docker', '.git', '.kube', '.ssh'])
const SENSITIVE_NAME_PATTERN = /(^|[-_.])(secret|secrets|token|tokens|credential|credentials|service-account|service_account|private-key|private_key|api-key|api_key)([-_.]|$)/i
const FILENAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

type NodeFsError = Error & { code?: string }
type FileIdentity = {
    dev: number | bigint
    ino: number | bigint
}

function isNodeFsError(error: unknown): error is NodeFsError {
    return error instanceof Error && typeof (error as NodeFsError).code === 'string'
}

function toSafeAttachmentFileError(error: unknown): Error {
    if (isNodeFsError(error)) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
            return new Error('Attachment file was not found')
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            return new Error('Attachment file is not readable')
        }
        if (error.code === 'ELOOP') {
            return new Error('Refusing to attach a symbolic link')
        }
    }
    return new Error('Attachment file could not be read')
}

async function realpathSafe(path: string, fallbackMessage: string): Promise<string> {
    try {
        return await realpath(path)
    } catch (error) {
        if (fallbackMessage) {
            throw new Error(fallbackMessage)
        }
        throw toSafeAttachmentFileError(error)
    }
}

function sanitizeFilename(value: string): string {
    const cleaned = value
        .replace(FILENAME_CONTROL_CHARS, ' ')
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/[\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 255)
    return cleaned || 'attachment'
}

export function isFilesystemRootPath(path: string): boolean {
    return parse(path).root === path || win32.parse(path).root === path
}

function isPathWithinBase(targetRealPath: string, baseRealPath: string): boolean {
    if (isFilesystemRootPath(baseRealPath)) return false
    if (targetRealPath === baseRealPath) return true
    const separator = baseRealPath.includes('\\') ? '\\' : '/'
    const prefix = baseRealPath.endsWith(separator) ? baseRealPath : `${baseRealPath}${separator}`
    return targetRealPath.startsWith(prefix)
}

function isLexicallyWithinBase(targetPath: string, basePath: string): boolean {
    const relativePath = relative(basePath, targetPath)
    return relativePath !== ''
        && !relativePath.startsWith('..')
        && !isAbsolute(relativePath)
}

function normalizeMimeType(value: string): string {
    return value
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase() || 'application/octet-stream'
}

function assertValidMimeType(value: string): void {
    if (!MIME_TYPE_PATTERN.test(value)) {
        throw new Error('Invalid MIME type for attachment')
    }
}

function inferMimeType(path: string, filename: string, explicitMimeType?: string): string {
    const explicit = explicitMimeType ? normalizeMimeType(explicitMimeType) : ''
    if (explicit) {
        assertValidMimeType(explicit)
        return explicit
    }
    const extension = extname(filename || path).toLowerCase() || extname(path).toLowerCase()
    return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

function assertSafeAttachmentType(path: string, filename: string, mimeType: string): void {
    const extensions = [
        extname(path).toLowerCase(),
        extname(filename).toLowerCase()
    ].filter(Boolean)
    const lowerMime = normalizeMimeType(mimeType)
    const blockedExtension = extensions.find((extension) => ACTIVE_CONTENT_EXTENSIONS.has(extension))
    if (blockedExtension || ACTIVE_CONTENT_MIME_TYPES.has(lowerMime)) {
        throw new Error(`Attachment type is not allowed for inline delivery: ${blockedExtension || lowerMime}`)
    }
}

function assertNotSensitiveFile(filename: string): void {
    const lower = filename.toLowerCase()
    const extension = extname(lower)
    if (
        lower.startsWith('.')
        || lower.startsWith('.env')
        || lower.startsWith('id_')
        || SENSITIVE_EXTENSIONS.has(extension)
        || SENSITIVE_BASENAMES.has(lower)
        || SENSITIVE_NAME_PATTERN.test(lower)
    ) {
        throw new Error(`Refusing to attach sensitive-looking file: ${filename}`)
    }
}

function assertNotSensitivePath(relativePath: string): void {
    const segments = relativePath.split(/[\\/]+/).filter(Boolean)
    for (const segment of segments) {
        const lowerSegment = segment.toLowerCase()
        if (lowerSegment.startsWith('.') || SENSITIVE_PATH_SEGMENTS.has(lowerSegment)) {
            throw new Error('Refusing to attach sensitive-looking file')
        }
    }
    const last = segments[segments.length - 1]
    if (last) {
        assertNotSensitiveFile(last)
    }
}

function assertWorkingDirectoryNotSensitive(realPathValue: string): void {
    const segments = realPathValue.split(/[\\/]+/).filter(Boolean)
    for (const segment of segments) {
        if (SENSITIVE_PATH_SEGMENTS.has(segment.toLowerCase())) {
            throw new Error('Attachments are not supported from a sensitive working directory')
        }
    }
}

function getFileIdentity(stats: { dev: number | bigint, ino: number | bigint }): FileIdentity {
    return {
        dev: stats.dev,
        ino: stats.ino
    }
}

function assertSameFileIdentity(actual: FileIdentity, expected: FileIdentity): void {
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new Error('Attachment changed while it was being read')
    }
}

async function resolveAttachmentFile(input: AgentAttachmentFileInput, workingDirectory: string): Promise<{
    realPath: string
    filename: string
    mimeType: string
    size: number
    identity: FileIdentity
}> {
    if (!input.path || typeof input.path !== 'string') {
        throw new Error('Attachment path is required')
    }
    if (!workingDirectory || typeof workingDirectory !== 'string') {
        throw new Error('Attachments are not supported in this session because there is no working directory.')
    }

    const baseRealPath = await realpathSafe(workingDirectory, 'Attachment working directory is not available')
    assertWorkingDirectoryNotSensitive(baseRealPath)
    if (isFilesystemRootPath(baseRealPath)) {
        throw new Error('Refusing to attach files when the working directory is the filesystem root')
    }
    if (isAbsolute(input.path)) {
        throw new Error('Attachment path is outside the working directory')
    }
    const candidatePath = resolve(workingDirectory, input.path)
    if (!isLexicallyWithinBase(candidatePath, workingDirectory)) {
        throw new Error('Attachment path is outside the working directory')
    }
    assertNotSensitivePath(relative(workingDirectory, candidatePath))
    const linkStats = await lstat(candidatePath).catch((error) => {
        throw toSafeAttachmentFileError(error)
    })
    if (linkStats.isSymbolicLink()) {
        throw new Error('Refusing to attach a symbolic link')
    }
    if (!linkStats.isFile()) {
        throw new Error('Only regular files can be attached')
    }

    const realPath = await realpathSafe(candidatePath, '')
    if (!isPathWithinBase(realPath, baseRealPath)) {
        throw new Error('Attachment path is outside the working directory')
    }
    assertNotSensitivePath(relative(baseRealPath, realPath))

    const fileStats = await stat(realPath).catch((error) => {
        throw toSafeAttachmentFileError(error)
    })
    const filename = sanitizeFilename(input.filename ?? basename(realPath))
    assertNotSensitiveFile(basename(realPath))
    assertNotSensitiveFile(filename)
    const mimeType = inferMimeType(realPath, filename, input.mimeType)
    assertSafeAttachmentType(realPath, filename, mimeType)

    return {
        realPath,
        filename,
        mimeType,
        size: fileStats.size,
        identity: getFileIdentity(fileStats)
    }
}

async function readBoundedFile(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let totalBytes = 0

    while (true) {
        const nextReadSize = Math.min(MAX_AGENT_ATTACHMENT_READ_CHUNK_BYTES, maxBytes + 1 - totalBytes)
        const chunk = Buffer.allocUnsafe(nextReadSize)
        const { bytesRead } = await handle.read(chunk, 0, nextReadSize, null)
        if (bytesRead === 0) break
        totalBytes += bytesRead
        if (totalBytes > maxBytes) {
            throw new Error(`Attachment payload is too large (max ${MAX_AGENT_ATTACHMENT_TOTAL_BYTES} bytes total)`)
        }
        chunks.push(chunk.subarray(0, bytesRead))
    }

    return Buffer.concat(chunks, totalBytes)
}

async function readRegularFileNoFollow(path: string, maxBytes: number, expectedIdentity: FileIdentity): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
        throw toSafeAttachmentFileError(error)
    })
    try {
        const stats = await handle.stat()
        if (!stats.isFile()) {
            throw new Error('Only regular files can be attached')
        }
        assertSameFileIdentity(getFileIdentity(stats), expectedIdentity)
        if (stats.size > maxBytes) {
            throw new Error(`Attachment payload is too large (max ${MAX_AGENT_ATTACHMENT_TOTAL_BYTES} bytes total)`)
        }
        const buffer = await readBoundedFile(handle, maxBytes)
        if (buffer.length !== stats.size) {
            throw new Error('Attachment changed while it was being read')
        }
        if (buffer.length > maxBytes) {
            throw new Error(`Attachment payload is too large (max ${MAX_AGENT_ATTACHMENT_TOTAL_BYTES} bytes total)`)
        }
        return buffer
    } catch (error) {
        if (error instanceof Error && (
            error.message === 'Only regular files can be attached'
            || error.message === 'Attachment changed while it was being read'
            || error.message.startsWith('Attachment payload is too large')
        )) {
            throw error
        }
        throw toSafeAttachmentFileError(error)
    } finally {
        await handle.close()
    }
}

export async function buildAgentAttachments(
    files: AgentAttachmentFileInput[],
    workingDirectory: string
): Promise<AttachmentMetadata[]> {
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error('At least one attachment file is required')
    }
    if (files.length > MAX_AGENT_ATTACHMENT_FILES) {
        throw new Error(`Too many attachment files (max ${MAX_AGENT_ATTACHMENT_FILES})`)
    }

    const resolved = [] as Awaited<ReturnType<typeof resolveAttachmentFile>>[]
    const seenPaths = new Set<string>()

    for (const file of files) {
        const item = await resolveAttachmentFile(file, workingDirectory)
        if (seenPaths.has(item.realPath)) {
            throw new Error(`Duplicate attachment path: ${item.filename}`)
        }
        seenPaths.add(item.realPath)
        resolved.push(item)
    }

    const attachments: AttachmentMetadata[] = []
    let totalBytes = 0
    for (const item of resolved) {
        if (item.size > MAX_AGENT_ATTACHMENT_TOTAL_BYTES - totalBytes) {
            throw new Error(`Attachment payload is too large (max ${MAX_AGENT_ATTACHMENT_TOTAL_BYTES} bytes total)`)
        }
        const buffer = await readRegularFileNoFollow(item.realPath, MAX_AGENT_ATTACHMENT_TOTAL_BYTES - totalBytes, item.identity)
        totalBytes += buffer.length
        if (totalBytes > MAX_AGENT_ATTACHMENT_TOTAL_BYTES) {
            throw new Error(`Attachment payload is too large (max ${MAX_AGENT_ATTACHMENT_TOTAL_BYTES} bytes total)`)
        }
        const id = `agent-att-${randomUUID()}`
        attachments.push({
            id,
            filename: item.filename,
            mimeType: item.mimeType,
            size: buffer.length,
            path: `hapi-agent-inline://${id}/${encodeURIComponent(item.filename)}`,
            previewUrl: `data:${item.mimeType};base64,${buffer.toString('base64')}`
        })
    }

    return attachments
}
