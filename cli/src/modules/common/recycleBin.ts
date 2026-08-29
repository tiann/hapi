import { constants, type Stats } from 'node:fs'
import {
    chmod,
    lstat,
    link,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rm,
    unlink,
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock'
import type {
    EmptyRecycleBinResponse,
    MoveFileToRecycleBinResponse,
    ReadRecycleBinEntryResponse,
    RecycleBinEntry,
    RecycleBinListResponse,
    RecycleBinRestoreConflict,
    RestoreRecycleBinEntryResponse,
    PurgeRecycleBinEntryResponse,
} from '@hapi/protocol/apiTypes'
import { RecycleBinRestoreConflictSchema } from '@hapi/protocol/apiTypes'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { logger } from '@/ui/logger'

export const DEFAULT_RECYCLE_BIN_RETENTION_DAYS = 30
export const MAX_RECYCLE_BIN_RETENTION_DAYS = 3650
export const MAX_RECYCLE_BIN_PREVIEW_BYTES = 5 * 1024 * 1024

const DAY_MS = 24 * 60 * 60 * 1000
const RECYCLE_BIN_DIRECTORY = 'recycle-bin'
const RECYCLE_BIN_LOCK_FILE = 'recycle-bin.lock'
const ENTRY_METADATA_FILE = 'metadata.json'
const ENTRY_PAYLOAD_FILE = 'payload'
const RECYCLE_BIN_METADATA_VERSION = 2
const RECYCLE_ENTRY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const READ_FILE_FLAGS = process.platform === 'win32'
    ? 'r'
    : constants.O_RDONLY | constants.O_NOFOLLOW

type FileStats = Stats

type StoredRecycleBinEntry = RecycleBinEntry & {
    version: typeof RECYCLE_BIN_METADATA_VERSION
    ownerNamespace: string
    scopeRoot: string
    mode: number
    contentHash: string
}

const StoredRecycleBinEntrySchema = z.object({
    version: z.literal(RECYCLE_BIN_METADATA_VERSION),
    id: z.string().regex(RECYCLE_ENTRY_ID_PATTERN),
    name: z.string().min(1),
    originalPath: z.string().min(1),
    ownerNamespace: z.string().min(1),
    scopeRoot: z.string().min(1),
    type: z.literal('file'),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    deletedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
})

type ResolvedRoot = {
    root: string
}

type ResolvedFile = {
    path: string
    stats: FileStats
}

function hasGitMetadataSegment(path: string): boolean {
    return path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === '.git')
}

function normalizeForComparison(path: string): string {
    const normalized = resolve(path)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathWithin(candidate: string, root: string): boolean {
    const child = normalizeForComparison(candidate)
    const parent = normalizeForComparison(root)
    if (child === parent) return true
    const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`
    return child.startsWith(prefix)
}

function isSameFileStats(left: FileStats, right: FileStats): boolean {
    return left.isFile()
        && right.isFile()
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function recycleBinEntryNotFound(): Error {
    const error = new Error('Recycle-bin entry not found') as NodeJS.ErrnoException
    error.name = 'RecycleBinEntryNotFoundError'
    error.code = 'ENOENT'
    return error
}

function isUnsupportedDirectorySync(error: unknown): boolean {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    return code === 'EINVAL' || code === 'EISDIR' || code === 'ENOTSUP' || code === 'EPERM'
}

async function syncDirectory(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
        await handle.sync()
    } catch (error) {
        if (!isUnsupportedDirectorySync(error) || process.platform !== 'win32') {
            throw error
        }
    } finally {
        if (handle) await handle.close()
    }
}

async function syncParentDirectory(path: string): Promise<void> {
    await syncDirectory(dirname(path))
}

function publicEntry(entry: StoredRecycleBinEntry): RecycleBinEntry {
    return {
        id: entry.id,
        name: entry.name,
        originalPath: entry.originalPath,
        type: entry.type,
        size: entry.size,
        deletedAt: entry.deletedAt,
        expiresAt: entry.expiresAt,
    }
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback
}

function invalidPathError(message: string = 'Invalid recycle-bin path'): Error {
    const error = new Error(message)
    error.name = 'RecycleBinInvalidPathError'
    return error
}

async function ensureFile(path: string): Promise<void> {
    const handle = await open(path, 'a')
    await handle.close()
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    try {
        const handle = await open(temporaryPath, 'wx', 0o600)
        try {
            await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
            await handle.chmod(0o600)
            await handle.sync()
        } finally {
            await handle.close()
        }
        await rename(temporaryPath, path)
        await syncParentDirectory(path)
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {})
        throw error
    }
}

async function readRegularFileStats(path: string): Promise<FileStats> {
    const handle = await open(path, READ_FILE_FLAGS)
    try {
        const stats = await handle.stat()
        if (!stats.isFile()) {
            throw invalidPathError('Only regular files can be moved to the HAPI Recycle Bin')
        }
        return stats
    } finally {
        await handle.close()
    }
}

async function readUtf8FileNoFollow(path: string): Promise<string> {
    const handle = await open(path, READ_FILE_FLAGS)
    try {
        const stats = await handle.stat()
        if (!stats.isFile()) throw new Error('Recycle-bin entry metadata is invalid')
        return await handle.readFile({ encoding: 'utf8' })
    } finally {
        await handle.close()
    }
}

async function readBinaryFileNoFollow(path: string, expectedSize: number): Promise<Buffer> {
    const handle = await open(path, READ_FILE_FLAGS)
    try {
        const stats = await handle.stat()
        if (!stats.isFile() || stats.size !== expectedSize) {
            throw new Error('Recycle-bin entry payload changed')
        }
        const content = await handle.readFile()
        const finalStats = await handle.stat()
        if (!finalStats.isFile() || finalStats.size !== expectedSize) {
            throw new Error('Recycle-bin entry payload changed')
        }
        return content
    } finally {
        await handle.close()
    }
}

async function assertPayloadIntegrity(entry: StoredRecycleBinEntry, payloadPath: string): Promise<void> {
    const payloadStats = await lstat(payloadPath)
    if (payloadStats.isSymbolicLink() || !payloadStats.isFile() || payloadStats.size !== entry.size) {
        throw new Error('Recycle-bin entry payload changed')
    }
    const actualHash = await hashFile(payloadPath)
    if (actualHash !== entry.contentHash) {
        throw new Error('Recycle-bin entry payload changed')
    }
}

async function assertFileUnchanged(path: string, expected: FileStats): Promise<FileStats> {
    let current: FileStats
    try {
        current = await lstat(path)
    } catch (error) {
        if (isNotFound(error)) {
            throw new Error('File changed before the recycle-bin operation completed')
        }
        throw error
    }
    if (!isSameFileStats(current, expected)) {
        throw new Error('File changed before the recycle-bin operation completed')
    }
    return current
}

async function hashFile(path: string): Promise<string> {
    const handle = await open(path, READ_FILE_FLAGS)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    try {
        const stats = await handle.stat()
        if (!stats.isFile()) throw invalidPathError('Recycle entry payload is not a regular file')
        let offset = 0
        while (offset < stats.size) {
            const result = await handle.read(buffer, 0, Math.min(buffer.length, stats.size - offset), offset)
            if (result.bytesRead === 0) {
                throw new Error('Recycle entry changed while it was being read')
            }
            hash.update(buffer.subarray(0, result.bytesRead))
            offset += result.bytesRead
        }
        return hash.digest('hex')
    } finally {
        await handle.close()
    }
}

type RecycleBinCopyOptions = {
    /** Mode to apply after copying, preserving bits that the process umask masks at creation. */
    mode?: number
    /** Keep the source in place when the destination is only a staging copy. */
    unlinkSource?: boolean
    /** Stable entry id used to name a recoverable source-detach staging file. */
    stageId?: string
}

async function copyFileWithoutReplacing(
    sourcePath: string,
    destinationPath: string,
    expected: FileStats,
    options: RecycleBinCopyOptions = {},
): Promise<void> {
    const sourceHandle = await open(sourcePath, READ_FILE_FLAGS)
    let destinationCreated = false
    let sourceRemoved = false
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    try {
        const openedStats = await sourceHandle.stat()
        if (!isSameFileStats(openedStats, expected)) {
            throw new Error('File changed before the recycle-bin operation completed')
        }
        const desiredMode = (options.mode ?? openedStats.mode) & 0o7777
        const destinationHandle = await open(destinationPath, 'wx', desiredMode)
        destinationCreated = true
        try {
            while (offset < openedStats.size) {
                const result = await sourceHandle.read(buffer, 0, Math.min(buffer.length, openedStats.size - offset), offset)
                if (result.bytesRead === 0) {
                    throw new Error('File changed while it was being moved')
                }
                let written = 0
                while (written < result.bytesRead) {
                    const writeResult = await destinationHandle.write(
                        buffer,
                        written,
                        result.bytesRead - written,
                        offset + written,
                    )
                    if (writeResult.bytesWritten === 0) {
                        throw new Error('Failed to write recycle-bin destination')
                    }
                    written += writeResult.bytesWritten
                }
                offset += written
            }
            await destinationHandle.chmod(desiredMode)
            await destinationHandle.sync()
        } finally {
            await destinationHandle.close()
        }

        await syncParentDirectory(destinationPath)
        if (options.unlinkSource !== false) {
            if (!options.stageId) {
                throw new Error('Recycle-bin staging id is required when removing the source')
            }
            const detachedPath = join(dirname(sourcePath), `.hapi-source-${options.stageId}.tmp`)
            await rename(sourcePath, detachedPath)
            const detachedStats = await lstat(detachedPath)
            if (!isSameFileStats(detachedStats, openedStats)) {
                if (!(await pathExists(sourcePath))) {
                    await rename(detachedPath, sourcePath)
                    await syncParentDirectory(sourcePath)
                }
                throw new Error('File changed before the recycle-bin operation completed')
            }
            sourceRemoved = true
            try {
                await unlink(detachedPath)
            } catch (error) {
                logger.debug('[RECYCLE BIN] Deferring detached-source cleanup', { detachedPath, error })
            }
            await syncParentDirectory(sourcePath)
        }
    } catch (error) {
        if (destinationCreated && !sourceRemoved) {
            await rm(destinationPath, { force: true }).catch(() => {})
        }
        throw error
    } finally {
        await sourceHandle.close()
    }
}

type MoveFileOptions = RecycleBinCopyOptions

async function moveRegularFile(
    sourcePath: string,
    destinationPath: string,
    expected?: FileStats,
    options: MoveFileOptions = {},
): Promise<void> {
    const sourceStats = expected ?? await readRegularFileStats(sourcePath)
    await assertFileUnchanged(sourcePath, sourceStats)
    if (await pathExists(destinationPath)) {
        throw new Error('Recycle-bin operation destination already exists')
    }

    // Always copy the source into a new inode. A same-filesystem rename would
    // leave the recycle payload writable through descriptors opened before the
    // deletion, so subsequent writes could mutate the supposedly immutable
    // recovery snapshot.
    await copyFileWithoutReplacing(sourcePath, destinationPath, sourceStats, options)
}

export function resolveRecycleBinRetentionDays(value: unknown): number {
    if (
        typeof value === 'number'
        && Number.isInteger(value)
        && value >= 1
        && value <= MAX_RECYCLE_BIN_RETENTION_DAYS
    ) {
        return value
    }
    if (value !== undefined) {
        logger.debug('[RECYCLE BIN] Invalid recycleBinRetentionDays; using default', { value })
    }
    return DEFAULT_RECYCLE_BIN_RETENTION_DAYS
}

async function loadRetentionDays(): Promise<number> {
    const settings = await readSettings()
    return resolveRecycleBinRetentionDays(settings.recycleBinRetentionDays)
}

export function getRecycleBinRoot(homeDir: string = configuration.happyHomeDir): string {
    return join(homeDir, RECYCLE_BIN_DIRECTORY)
}

export function getRecycleBinLockPath(homeDir: string = configuration.happyHomeDir): string {
    return join(homeDir, RECYCLE_BIN_LOCK_FILE)
}

async function withRecycleBinLock<T>(homeDir: string, work: () => Promise<T>): Promise<T> {
    const root = getRecycleBinRoot(homeDir)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootStats = await lstat(root)
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error('HAPI Recycle Bin storage is invalid')
    }
    await chmod(root, 0o700).catch(() => {})
    await syncParentDirectory(root)

    const lockPath = getRecycleBinLockPath(homeDir)
    await ensureFile(lockPath)
    return await withSettingsFileLock(lockPath, work)
}

async function resolveWorkingRoot(workingDirectory: string, protectedRoot?: string): Promise<ResolvedRoot> {
    if (!workingDirectory.trim()) {
        throw invalidPathError('Session working directory is unavailable')
    }
    const root = await realpath(resolve(workingDirectory))
    const rootStats = await lstat(root)
    if (!rootStats.isDirectory()) {
        throw invalidPathError('Session working directory is not a directory')
    }
    if (hasGitMetadataSegment(root)) {
        throw invalidPathError('Git metadata cannot be used as a recycle-bin scope')
    }
    if (protectedRoot && isPathWithin(root, protectedRoot)) {
        throw invalidPathError('HAPI Recycle Bin storage is protected')
    }
    return { root }
}

async function resolveExistingFile(rawPath: string, root: string, protectedRoot?: string): Promise<ResolvedFile> {
    if (!rawPath.trim()) throw invalidPathError('File path is required')
    const lexicalPath = resolve(root, rawPath)
    if (
        !isPathWithin(lexicalPath, root)
        || hasGitMetadataSegment(lexicalPath)
        || (protectedRoot && isPathWithin(lexicalPath, protectedRoot))
    ) {
        throw invalidPathError('File path is outside the authorized working directory')
    }

    const lexicalStats = await lstat(lexicalPath)
    if (lexicalStats.isSymbolicLink()) {
        throw invalidPathError('Symlink paths cannot be moved to the HAPI Recycle Bin')
    }
    if (!lexicalStats.isFile()) {
        throw invalidPathError('Only regular files can be moved to the HAPI Recycle Bin')
    }

    const canonicalPath = await realpath(lexicalPath)
    if (
        !isPathWithin(canonicalPath, root)
        || hasGitMetadataSegment(canonicalPath)
        || (protectedRoot && isPathWithin(canonicalPath, protectedRoot))
    ) {
        throw invalidPathError('File path is outside the authorized working directory')
    }

    const stats = await readRegularFileStats(canonicalPath)
    return { path: canonicalPath, stats }
}

async function resolveRestoreTarget(originalPath: string, root: string, protectedRoot?: string): Promise<string> {
    if (
        !isPathWithin(originalPath, root)
        || hasGitMetadataSegment(originalPath)
        || (protectedRoot && isPathWithin(originalPath, protectedRoot))
    ) {
        throw invalidPathError('Restore target is outside the authorized working directory')
    }

    const target = resolve(originalPath)
    const parent = dirname(target)
    let canonicalParent: string
    try {
        canonicalParent = await realpath(parent)
    } catch (error) {
        if (isNotFound(error)) {
            throw invalidPathError('The original restore directory no longer exists')
        }
        throw error
    }
    if (
        !isPathWithin(canonicalParent, root)
        || hasGitMetadataSegment(canonicalParent)
        || (protectedRoot && isPathWithin(canonicalParent, protectedRoot))
    ) {
        throw invalidPathError('Restore target is outside the authorized working directory')
    }

    try {
        const existing = await lstat(target)
        if (existing.isSymbolicLink()) {
            throw invalidPathError('A symlink occupies the restore target')
        }
    } catch (error) {
        if (!isNotFound(error)) throw error
    }

    return target
}

function getEntryDirectory(root: string, entryId: string): string {
    if (!RECYCLE_ENTRY_ID_PATTERN.test(entryId)) {
        throw invalidPathError('Invalid recycle-bin entry id')
    }
    return join(root, entryId)
}

async function readStoredEntry(root: string, entryId: string): Promise<StoredRecycleBinEntry> {
    try {
        const entry = await readStoredEntryMetadata(root, entryId)
        const payloadPath = join(getEntryDirectory(root, entryId), ENTRY_PAYLOAD_FILE)
        const payloadStats = await lstat(payloadPath)
        if (!payloadStats.isFile() || payloadStats.isSymbolicLink()) {
            throw new Error('Recycle-bin entry payload is invalid')
        }
        if (payloadStats.size !== entry.size) {
            throw new Error('Recycle-bin entry payload changed')
        }

        return entry
    } catch (error) {
        if (isNotFound(error)) throw recycleBinEntryNotFound()
        throw error
    }
}

async function readStoredEntryMetadata(root: string, entryId: string): Promise<StoredRecycleBinEntry> {
    try {
        const directory = getEntryDirectory(root, entryId)
        const metadataPath = join(directory, ENTRY_METADATA_FILE)
        const directoryStats = await lstat(directory)
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
            throw new Error('Recycle-bin entry directory is invalid')
        }
        const metadataStats = await lstat(metadataPath)
        if (!metadataStats.isFile() || metadataStats.isSymbolicLink()) {
            throw new Error('Recycle-bin entry metadata is invalid')
        }
        const raw = await readUtf8FileNoFollow(metadataPath)
        const parsed = StoredRecycleBinEntrySchema.safeParse(JSON.parse(raw) as unknown)
        if (!parsed.success || parsed.data.id !== entryId) {
            throw new Error('Recycle-bin entry metadata is invalid')
        }
        return parsed.data
    } catch (error) {
        if (isNotFound(error)) throw recycleBinEntryNotFound()
        throw error
    }
}

const MAX_ORPHANED_RECYCLE_ENTRY_AGE_MS = MAX_RECYCLE_BIN_RETENTION_DAYS * DAY_MS

async function removeConservativelyStaleEntry(root: string, entryId: string, now: number): Promise<boolean> {
    const directory = join(root, entryId)
    let stats: FileStats
    try {
        stats = await lstat(directory)
    } catch (error) {
        if (isNotFound(error)) return false
        throw error
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.mtimeMs > now - MAX_ORPHANED_RECYCLE_ENTRY_AGE_MS) {
        return false
    }
    await rm(directory, { recursive: true, force: true })
    return true
}

async function reconcileEntryStagingFiles(
    root: string,
    entry: StoredRecycleBinEntry,
    protectedRoot?: string,
): Promise<void> {
    const workspaceDirectory = await realpath(dirname(entry.originalPath)).catch(() => null)
    if (
        !workspaceDirectory
        || !isPathWithin(workspaceDirectory, entry.scopeRoot)
        || hasGitMetadataSegment(workspaceDirectory)
        || (protectedRoot && isPathWithin(workspaceDirectory, protectedRoot))
    ) {
        return
    }

    const stagingDirectories = new Set([
        workspaceDirectory,
        join(root, entry.id),
    ])
    const stagingNames = [
        `.hapi-source-${entry.id}.tmp`,
        `.hapi-restore-${entry.id}.tmp`,
    ]
    for (const directory of stagingDirectories) {
        for (const name of stagingNames) {
            const stagingPath = join(directory, name)
            try {
                const stats = await lstat(stagingPath)
                if (stats.isFile() && !stats.isSymbolicLink() && stats.size === entry.size) {
                    const contentHash = await hashFile(stagingPath)
                    const finalStats = await lstat(stagingPath)
                    if (contentHash !== entry.contentHash || !isSameFileStats(stats, finalStats)) continue
                    await rm(stagingPath, { force: true })
                }
            } catch (error) {
                if (!isNotFound(error)) {
                    logger.debug('[RECYCLE BIN] Failed to reconcile staging file', { stagingPath, error })
                }
            }
        }
    }
}

async function cleanupExpiredUnlocked(root: string, now: number, protectedRoot?: string): Promise<void> {
    let entries: string[]
    try {
        entries = await readdir(root)
    } catch (error) {
        if (isNotFound(error)) return
        throw error
    }

    let removedAny = false
    for (const entryId of entries) {
        if (!RECYCLE_ENTRY_ID_PATTERN.test(entryId)) continue
        try {
            const entry = await readStoredEntryMetadata(root, entryId)
            await reconcileEntryStagingFiles(root, entry, protectedRoot)
            if (entry.expiresAt <= now) {
                await rm(join(root, entryId), { recursive: true, force: true })
                removedAny = true
            }
        } catch (error) {
            if (await removeConservativelyStaleEntry(root, entryId, now)) {
                removedAny = true
                continue
            }
            if (!isNotFound(error)) {
                logger.debug('[RECYCLE BIN] Failed to inspect entry during cleanup', { entryId, error })
            }
        }
    }
    if (removedAny) await syncDirectory(root)
}

async function listStoredEntriesUnlocked(root: string, now: number): Promise<StoredRecycleBinEntry[]> {
    let names: string[]
    try {
        names = await readdir(root)
    } catch (error) {
        if (isNotFound(error)) return []
        throw error
    }

    const entries: StoredRecycleBinEntry[] = []
    for (const entryId of names) {
        if (!RECYCLE_ENTRY_ID_PATTERN.test(entryId)) continue
        try {
            const entry = await readStoredEntry(root, entryId)
            if (entry.expiresAt > now) entries.push(entry)
        } catch (error) {
            if (!isNotFound(error)) {
                logger.debug('[RECYCLE BIN] Ignoring invalid entry', { entryId, error })
            }
        }
    }

    return entries.sort((left, right) => right.deletedAt - left.deletedAt)
}

function isEntryVisible(entry: StoredRecycleBinEntry, root: string, protectedRoot: string | undefined, ownerNamespace: string): boolean {
    return entry.ownerNamespace === ownerNamespace
        && isPathWithin(entry.originalPath, root)
        && isPathWithin(entry.scopeRoot, root)
        && !hasGitMetadataSegment(entry.originalPath)
        && !(protectedRoot && isPathWithin(entry.originalPath, protectedRoot))
}

async function findRestoredName(target: string): Promise<string> {
    const parent = dirname(target)
    const extension = extname(target)
    const stem = basename(target, extension)
    for (let index = 1; index <= 1000; index += 1) {
        const suffix = index === 1 ? ' (restored)' : ` (restored ${index})`
        const candidate = join(parent, `${stem}${suffix}${extension}`)
        try {
            await lstat(candidate)
        } catch (error) {
            if (isNotFound(error)) return candidate
            throw error
        }
    }
    throw new Error('Unable to choose a free restored filename')
}

export class RecycleBinManager {
    constructor(
        private readonly homeDir: string = configuration.happyHomeDir,
        private readonly now: () => number = Date.now,
        private readonly readRetentionDays: () => Promise<number> = loadRetentionDays,
        private readonly ownerNamespace: string = 'default',
    ) {}

    async moveFile(rawPath: string, workingDirectory: string): Promise<MoveFileToRecycleBinResponse> {
        return await withRecycleBinLock(this.homeDir, async () => {
            const root = getRecycleBinRoot(this.homeDir)
            // Keep every HAPI-owned file out of the recycle-bin scope, not
            // only the recycle-bin directory itself.
            const protectedRoot = await realpath(this.homeDir)
            const currentTime = this.now()
            await cleanupExpiredUnlocked(root, currentTime, protectedRoot)
            const { root: scopeRoot } = await resolveWorkingRoot(workingDirectory, protectedRoot)
            const source = await resolveExistingFile(rawPath, scopeRoot, protectedRoot)
            const retentionDays = await this.readRetentionDays()
            const entryId = randomUUID()
            const entryDirectory = join(root, entryId)
            const payloadPath = join(entryDirectory, ENTRY_PAYLOAD_FILE)
            const metadataPath = join(entryDirectory, ENTRY_METADATA_FILE)
            const deletedAt = currentTime
            const entry: StoredRecycleBinEntry = {
                version: RECYCLE_BIN_METADATA_VERSION,
                id: entryId,
                name: basename(source.path),
                originalPath: source.path,
                ownerNamespace: this.ownerNamespace,
                scopeRoot,
                type: 'file',
                size: source.stats.size,
                mode: source.stats.mode,
                contentHash: await hashFile(source.path),
                deletedAt,
                expiresAt: deletedAt + retentionDays * DAY_MS,
            }

            await mkdir(entryDirectory, { recursive: false, mode: 0o700 })
            try {
                await writeJsonAtomically(metadataPath, entry)
                await syncParentDirectory(entryDirectory)
                await moveRegularFile(source.path, payloadPath, source.stats, { stageId: entryId })
                await assertPayloadIntegrity(entry, payloadPath)
            } catch (error) {
                let rollbackError: unknown = null
                if (await pathExists(payloadPath)) {
                    try {
                        await moveRegularFile(payloadPath, source.path, undefined, { stageId: entryId })
                    } catch (error) {
                        rollbackError = error
                        logger.debug('[RECYCLE BIN] Failed to roll back a failed move', { rollbackError })
                    }
                }
                if (!rollbackError) {
                    await rm(entryDirectory, { recursive: true, force: true }).catch(() => {})
                } else {
                    throw new Error('File move failed and the recycle-bin entry was retained for recovery')
                }
                throw error
            }

            return {
                success: true,
                entry: publicEntry(entry),
                retentionDays,
            }
        }).catch((error) => ({
            success: false,
            error: errorMessage(error, 'Failed to move file to the HAPI Recycle Bin'),
        }))
    }

    async list(workingDirectory: string): Promise<RecycleBinListResponse> {
        return await withRecycleBinLock(this.homeDir, async () => {
            const root = getRecycleBinRoot(this.homeDir)
            const protectedRoot = await realpath(this.homeDir)
            const currentTime = this.now()
            await cleanupExpiredUnlocked(root, currentTime, protectedRoot)
            const { root: scopeRoot } = await resolveWorkingRoot(workingDirectory, protectedRoot)
            const entries = await listStoredEntriesUnlocked(root, currentTime)
            const retentionDays = await this.readRetentionDays()
            return {
                success: true,
                entries: entries.filter((entry) => isEntryVisible(entry, scopeRoot, protectedRoot, this.ownerNamespace)).map(publicEntry),
                retentionDays,
            }
        }).catch((error) => ({
            success: false,
            error: errorMessage(error, 'Failed to list the HAPI Recycle Bin'),
        }))
    }

    async read(entryId: string, workingDirectory: string): Promise<ReadRecycleBinEntryResponse> {
        return await withRecycleBinLock(this.homeDir, async () => {
            const root = getRecycleBinRoot(this.homeDir)
            const protectedRoot = await realpath(this.homeDir)
            const currentTime = this.now()
            await cleanupExpiredUnlocked(root, currentTime, protectedRoot)
            const { root: scopeRoot } = await resolveWorkingRoot(workingDirectory, protectedRoot)
            const entry = await readStoredEntry(root, entryId)
            if (entry.expiresAt <= currentTime || !isEntryVisible(entry, scopeRoot, protectedRoot, this.ownerNamespace)) {
                throw recycleBinEntryNotFound()
            }
            if (entry.size > MAX_RECYCLE_BIN_PREVIEW_BYTES) {
                return {
                    success: false,
                    name: entry.name,
                    size: entry.size,
                    modified: entry.deletedAt,
                    error: `File is too large to preview (max ${MAX_RECYCLE_BIN_PREVIEW_BYTES} bytes)`,
                }
            }
            const payloadPath = join(root, entry.id, ENTRY_PAYLOAD_FILE)
            const content = await readBinaryFileNoFollow(payloadPath, entry.size)
            const actualHash = createHash('sha256').update(content).digest('hex')
            if (actualHash !== entry.contentHash) {
                throw new Error('Recycle-bin entry payload changed')
            }
            return {
                success: true,
                name: entry.name,
                content: content.toString('base64'),
                size: entry.size,
                modified: entry.deletedAt,
            }
        }).catch((error) => ({
            success: false,
            error: errorMessage(error, 'Failed to read the recycle-bin entry'),
        }))
    }

    async restore(
        entryId: string,
        workingDirectory: string,
        conflict: RecycleBinRestoreConflict,
    ): Promise<RestoreRecycleBinEntryResponse> {
        return await withRecycleBinLock<RestoreRecycleBinEntryResponse>(this.homeDir, async (): Promise<RestoreRecycleBinEntryResponse> => {
            const root = getRecycleBinRoot(this.homeDir)
            const protectedRoot = await realpath(this.homeDir)
            const currentTime = this.now()
            await cleanupExpiredUnlocked(root, currentTime, protectedRoot)
            const { root: scopeRoot } = await resolveWorkingRoot(workingDirectory, protectedRoot)
            const entry = await readStoredEntry(root, entryId)
            if (entry.expiresAt <= currentTime || !isEntryVisible(entry, scopeRoot, protectedRoot, this.ownerNamespace)) {
                throw recycleBinEntryNotFound()
            }
            const originalTarget = await resolveRestoreTarget(entry.originalPath, scopeRoot, protectedRoot)
            let target = originalTarget
            let targetExists = false
            try {
                const targetStats = await lstat(target)
                targetExists = true
                if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
                    throw invalidPathError('The restore target is not a regular file')
                }
            } catch (error) {
                if (!isNotFound(error)) throw error
            }

            if (targetExists && conflict === 'cancel') {
                return { success: true, cancelled: true, targetPath: target }
            }
            if (targetExists && conflict === 'fail') {
                return {
                    success: false,
                    code: 'target_exists',
                    targetPath: target,
                    error: 'The original restore target already exists',
                }
            }
            if (targetExists && conflict === 'new-name') {
                target = await findRestoredName(target)
            }
            if (!targetExists && conflict === 'cancel') {
                return { success: true, cancelled: true, targetPath: target }
            }

            const payloadPath = join(root, entry.id, ENTRY_PAYLOAD_FILE)
            const payloadStats = await readRegularFileStats(payloadPath)
            if (payloadStats.size !== entry.size) {
                throw new Error('Recycle-bin entry payload changed')
            }
            await assertPayloadIntegrity(entry, payloadPath)

            let stagedPath: string | null = null
            let stagedCreated = false
            try {
                stagedPath = join(dirname(target), `.hapi-restore-${entry.id}.tmp`)
                await copyFileWithoutReplacing(payloadPath, stagedPath, payloadStats, {
                    mode: entry.mode & 0o7777,
                    unlinkSource: false,
                })
                stagedCreated = true
                if (targetExists && conflict === 'overwrite') {
                    await rename(stagedPath, target)
                    await syncParentDirectory(target)
                } else {
                    // Publish a complete staged file without replacing a
                    // target that appeared after the conflict check.
                    await link(stagedPath, target)
                    await syncParentDirectory(target)
                    await unlink(stagedPath)
                    await syncParentDirectory(target)
                }
                await rm(join(root, entry.id), { recursive: true, force: true })
                await syncDirectory(root)
                return { success: true, restoredPath: target }
            } catch (error) {
                if (stagedCreated && stagedPath) {
                    await rm(stagedPath, { force: true }).catch(() => {})
                }
                throw error
            }
        }).catch((error): RestoreRecycleBinEntryResponse => {
            const response: RestoreRecycleBinEntryResponse = {
                success: false,
                error: errorMessage(error, 'Failed to restore the recycle-bin entry'),
            }
            if (error instanceof Error && error.name === 'RecycleBinEntryNotFoundError') {
                response.code = 'entry_not_found'
            }
            return response
        })
    }

    async purge(entryId: string, workingDirectory: string): Promise<PurgeRecycleBinEntryResponse> {
        return await withRecycleBinLock(this.homeDir, async () => {
            const root = getRecycleBinRoot(this.homeDir)
            const protectedRoot = await realpath(this.homeDir)
            const currentTime = this.now()
            await cleanupExpiredUnlocked(root, currentTime, protectedRoot)
            const { root: scopeRoot } = await resolveWorkingRoot(workingDirectory, protectedRoot)
            const entry = await readStoredEntry(root, entryId)
            if (entry.expiresAt <= currentTime || !isEntryVisible(entry, scopeRoot, protectedRoot, this.ownerNamespace)) {
                throw new Error('Recycle-bin entry not found')
            }
            await rm(join(root, entry.id), { recursive: true, force: true })
            await syncDirectory(root)
            return { success: true }
        }).catch((error) => ({
            success: false,
            error: errorMessage(error, 'Failed to permanently delete the recycle-bin entry'),
        }))
    }

    async empty(workingDirectory: string, entryIds: string[]): Promise<EmptyRecycleBinResponse> {
        return await withRecycleBinLock(this.homeDir, async () => {
            const root = getRecycleBinRoot(this.homeDir)
            const protectedRoot = await realpath(this.homeDir)
            const currentTime = this.now()
            await cleanupExpiredUnlocked(root, currentTime, protectedRoot)
            const { root: scopeRoot } = await resolveWorkingRoot(workingDirectory, protectedRoot)
            const entries = await listStoredEntriesUnlocked(root, currentTime)
            const requestedEntryIds = new Set(entryIds)
            const visible = entries.filter((entry) => requestedEntryIds.has(entry.id)
                && isEntryVisible(entry, scopeRoot, protectedRoot, this.ownerNamespace))
            let deletedCount = 0
            try {
                for (const entry of visible) {
                    await rm(join(root, entry.id), { recursive: true, force: true })
                    deletedCount += 1
                }
            } finally {
                if (deletedCount > 0) await syncDirectory(root)
            }
            return { success: true, deletedCount }
        }).catch((error) => ({
            success: false,
            error: errorMessage(error, 'Failed to empty the HAPI Recycle Bin'),
        }))
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path)
        return true
    } catch (error) {
        if (isNotFound(error)) return false
        throw error
    }
}

export function parseRecycleBinRestoreConflict(value: unknown): RecycleBinRestoreConflict | null {
    const parsed = RecycleBinRestoreConflictSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}
