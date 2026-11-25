import { appendFile, lstat, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
    CommandResponse,
    DirectoryEntry,
    FileMetadataEntry,
    FileReadResponse,
    ListDirectoryResponse,
    StatFilesResponse,
    WorkspaceWriteFileResponse,
} from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { runGitCommand } from './handlers/git'
import { run as runRipgrep, runFileSearch, type FileSearchOptions } from '@/modules/ripgrep/index'
import { MAX_GENERATED_IMAGE_BYTES, readBoundedRegularFile } from './generatedImages'
import { getErrorMessage, rpcError } from './rpcResponses'

/**
 * The runner is the authority for resolving and enforcing workspace paths.
 * Keeping this interface small lets the machine client own the policy while
 * these handlers remain focused on read-only file operations.
 */
export type WorkspaceFilePathPolicy = {
    resolveForCheck: (path: string) => Promise<string>
    isWithinSpawnRoots: (path: string) => boolean
}

type WorkspaceReadFileRequest = {
    cwd?: unknown
    path?: unknown
    maxBytes?: unknown
}

type WorkspaceListDirectoryRequest = {
    cwd?: unknown
    path?: unknown
}

type WorkspaceStatFilesRequest = {
    cwd?: unknown
    paths?: unknown
}

type WorkspaceGitStatusRequest = {
    cwd?: unknown
    timeout?: number
}

type WorkspaceGitDiffNumstatRequest = {
    cwd?: unknown
    staged?: boolean
    timeout?: number
}

type WorkspaceGitDiffFileRequest = {
    cwd?: unknown
    filePath?: unknown
    staged?: boolean
    timeout?: number
}

type WorkspaceRipgrepRequest = {
    cwd?: unknown
    args?: unknown
    fileSearch?: FileSearchOptions
}

type WorkspaceWriteFileRequest = {
    cwd?: unknown
    /** Target directory, relative to `cwd` ('' = workspace root). */
    dir?: unknown
    /** Plain file name; no path separators. */
    name?: unknown
    /** Client-generated id naming the temporary part file. */
    uploadId?: unknown
    /** Base64 chunk content; may be empty. */
    content?: unknown
    /** Byte offset of this chunk; 0 starts (or restarts) the upload. */
    offset?: unknown
    /** Move the part file onto the target after writing this chunk. */
    final?: unknown
    /** Replace an existing file at the target. */
    overwrite?: unknown
    /** Discard the part file instead of writing. */
    abort?: unknown
}


type WorkspaceDeletePathRequest = {
    cwd?: unknown
    path?: unknown
}

type ResolvedWorkspaceCwd = { cwd: string } | { error: string }
type ResolvedWorkspacePath = { cwd: string; path: string } | { error: string }

const OUTSIDE_WORKSPACE_ERROR = 'Path is outside workspace roots'
const OUTSIDE_SESSION_WORKSPACE_ERROR = 'Path is outside the session workspace'
export const MAX_WORKSPACE_FILE_BYTES = MAX_GENERATED_IMAGE_BYTES

function isWithinRoot(root: string, target: string): boolean {
    const child = relative(root, target)
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function resolveWorkspaceCwd(
    pathPolicy: WorkspaceFilePathPolicy,
    value: unknown,
): Promise<ResolvedWorkspaceCwd> {
    const raw = typeof value === 'string' ? value : ''
    if (!raw) {
        return { error: 'Workspace path is required' }
    }

    const cwd = await pathPolicy.resolveForCheck(raw)
    if (!pathPolicy.isWithinSpawnRoots(cwd)) {
        return { error: OUTSIDE_WORKSPACE_ERROR }
    }

    return { cwd }
}

async function resolveWorkspacePath(
    pathPolicy: WorkspaceFilePathPolicy,
    cwdValue: unknown,
    pathValue: unknown,
    options?: { allowEmptyPath?: boolean },
): Promise<ResolvedWorkspacePath> {
    const cwd = await resolveWorkspaceCwd(pathPolicy, cwdValue)
    if ('error' in cwd) {
        return cwd
    }

    const rawPath = typeof pathValue === 'string' ? pathValue : ''
    if (!options?.allowEmptyPath && !rawPath) {
        return { error: 'Path is required' }
    }

    const path = await pathPolicy.resolveForCheck(resolve(cwd.cwd, rawPath || '.'))
    if (!pathPolicy.isWithinSpawnRoots(path)) {
        return { error: OUTSIDE_WORKSPACE_ERROR }
    }
    if (!isWithinRoot(cwd.cwd, path)) {
        return { error: OUTSIDE_SESSION_WORKSPACE_ERROR }
    }

    return { cwd: cwd.cwd, path }
}

async function listDirectory(path: string): Promise<ListDirectoryResponse> {
    const entries = await readdir(path, { withFileTypes: true })
    const directoryEntries: DirectoryEntry[] = await Promise.all(
        entries.map(async (entry) => {
            const fullPath = join(path, entry.name)
            let type: DirectoryEntry['type'] = 'other'
            let size: number | undefined
            let modified: number | undefined

            if (entry.isDirectory()) {
                type = 'directory'
            } else if (entry.isFile()) {
                type = 'file'
            }

            if (!entry.isSymbolicLink()) {
                try {
                    const stats = await stat(fullPath)
                    size = stats.size
                    modified = stats.mtime.getTime()
                } catch {
                    // Keep the entry visible even when metadata is unavailable.
                }
            }

            return { name: entry.name, type, size, modified }
        }),
    )

    directoryEntries.sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') return -1
        if (left.type !== 'directory' && right.type === 'directory') return 1
        return left.name.localeCompare(right.name)
    })

    return { success: true, entries: directoryEntries }
}

const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const MAX_WORKSPACE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

function isPlainFileName(name: string): boolean {
    return name.length > 0
        && Buffer.byteLength(name) <= 255
        && name !== '.'
        && name !== '..'
        && !name.includes('/')
        && !name.includes('\\')
        && !name.includes('\0')
}

function uploadPartPath(dir: string, name: string, uploadId: string): string {
    return join(dir, `.${name}.hapi-upload-${uploadId}`)
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path)
        return true
    } catch {
        return false
    }
}

async function handleWorkspaceWriteFile(
    pathPolicy: WorkspaceFilePathPolicy,
    data: WorkspaceWriteFileRequest,
): Promise<WorkspaceWriteFileResponse> {
    const name = typeof data.name === 'string' ? data.name : ''
    if (!isPlainFileName(name)) {
        return rpcError('Invalid file name')
    }
    const uploadId = typeof data.uploadId === 'string' ? data.uploadId : ''
    if (!UPLOAD_ID_PATTERN.test(uploadId)) {
        return rpcError('Invalid upload id')
    }

    const resolved = await resolveWorkspacePath(pathPolicy, data.cwd, data.dir, { allowEmptyPath: true })
    if ('error' in resolved) {
        return rpcError(resolved.error)
    }

    try {
        const dirStats = await stat(resolved.path)
        if (!dirStats.isDirectory()) {
            return rpcError('Upload target is not a directory')
        }

        const target = join(resolved.path, name)
        const part = uploadPartPath(resolved.path, name, uploadId)

        if (data.abort === true) {
            await rm(part, { force: true })
            return { success: true }
        }

        const offset = typeof data.offset === 'number' && Number.isSafeInteger(data.offset) && data.offset >= 0
            ? data.offset
            : -1
        if (offset < 0) {
            return rpcError('Invalid offset')
        }
        const content = typeof data.content === 'string' ? Buffer.from(data.content, 'base64') : Buffer.alloc(0)
        if (content.byteLength > MAX_WORKSPACE_UPLOAD_CHUNK_BYTES) {
            return rpcError('Chunk too large')
        }
        const overwrite = data.overwrite === true

        if (offset === 0) {
            if (!overwrite && await pathExists(target)) {
                return { success: false, code: 'exists', error: 'A file with this name already exists' }
            }
            // Upload ids are random per attempt, so (re)starting truncates.
            await writeFile(part, content)
        } else {
            let partSize: number
            try {
                partSize = (await lstat(part)).size
            } catch {
                return rpcError('Upload was not started or has expired')
            }
            if (partSize !== offset) {
                return rpcError(`Unexpected offset ${offset}; ${partSize} bytes received so far`)
            }
            await appendFile(part, content)
        }

        const size = offset + content.byteLength
        if (data.final === true) {
            if (!overwrite && await pathExists(target)) {
                await rm(part, { force: true })
                return { success: false, code: 'exists', error: 'A file with this name already exists' }
            }
            const existing = await lstat(target).catch(() => null)
            if (existing?.isDirectory()) {
                await rm(part, { force: true })
                return rpcError('A folder with this name already exists')
            }
            await rename(part, target)
            const relativePath = relative(resolved.cwd, target).split(sep).join('/')
            return { success: true, size, path: relativePath }
        }

        return { success: true, size }
    } catch (error) {
        return rpcError(getErrorMessage(error, 'Failed to write file'))
    }
}

async function handleWorkspaceDeletePath(
    pathPolicy: WorkspaceFilePathPolicy,
    data: WorkspaceDeletePathRequest,
): Promise<{ success: boolean; error?: string }> {
    const cwd = await resolveWorkspaceCwd(pathPolicy, data.cwd)
    if ('error' in cwd) {
        return rpcError(cwd.error)
    }
    const rawPath = typeof data.path === 'string' ? data.path : ''
    const lexical = resolve(cwd.cwd, rawPath || '.')
    const name = basename(lexical)
    if (!rawPath || !isWithinRoot(cwd.cwd, lexical) || lexical === cwd.cwd || !isPlainFileName(name)) {
        return rpcError('Invalid path')
    }

    // Resolve only the parent: the entry itself may be a symlink, and deleting
    // must remove the link rather than whatever it points at.
    const parent = await pathPolicy.resolveForCheck(dirname(lexical))
    if (!pathPolicy.isWithinSpawnRoots(parent)) {
        return rpcError(OUTSIDE_WORKSPACE_ERROR)
    }
    if (!isWithinRoot(cwd.cwd, parent)) {
        return rpcError(OUTSIDE_SESSION_WORKSPACE_ERROR)
    }
    const target = join(parent, name)
    if (target === cwd.cwd) {
        return rpcError('Cannot delete the workspace root')
    }

    try {
        const stats = await lstat(target)
        if (stats.isDirectory()) {
            await rm(target, { recursive: true })
        } else {
            await unlink(target)
        }
        return { success: true }
    } catch (error) {
        return rpcError(getErrorMessage(error, 'Failed to delete'))
    }
}

/**
 * Register workspace operations on the machine-scoped runner socket: the
 * read-only file/Git/search RPCs plus upload/delete for the files panel. These are deliberately separate from session-scoped RPCs so an
 * inactive session can still inspect its current workspace while its CLI is
 * no longer connected.
 */
export function registerWorkspaceFileHandlers(
    rpcHandlerManager: RpcHandlerManager,
    pathPolicy: WorkspaceFilePathPolicy,
): void {
    rpcHandlerManager.registerHandler<WorkspaceReadFileRequest, FileReadResponse>(
        RPC_METHODS.WorkspaceReadFile,
        async (data) => {
            const resolved = await resolveWorkspacePath(pathPolicy, data.cwd, data.path)
            if ('error' in resolved) {
                return rpcError(resolved.error)
            }

            try {
                const stats = await stat(resolved.path)
                if (!stats.isFile()) {
                    throw new Error('Path is not a regular file')
                }
                const requestedMaxBytes = typeof data.maxBytes === 'number' && Number.isFinite(data.maxBytes) && data.maxBytes > 0
                    ? Math.floor(data.maxBytes)
                    : MAX_WORKSPACE_FILE_BYTES
                const maxBytes = Math.min(requestedMaxBytes, MAX_WORKSPACE_FILE_BYTES)
                const buffer = await readBoundedRegularFile(resolved.path, maxBytes)
                return {
                    success: true,
                    content: buffer.toString('base64'),
                    size: stats.size,
                    modified: stats.mtime.getTime(),
                }
            } catch (error) {
                return rpcError(getErrorMessage(error, 'Failed to read file'))
            }
        },
    )

    rpcHandlerManager.registerHandler<WorkspaceListDirectoryRequest, ListDirectoryResponse>(
        RPC_METHODS.WorkspaceListDirectory,
        async (data) => {
            const resolved = await resolveWorkspacePath(pathPolicy, data.cwd, data.path, { allowEmptyPath: true })
            if ('error' in resolved) {
                return rpcError(resolved.error)
            }

            try {
                return await listDirectory(resolved.path)
            } catch (error) {
                return rpcError(getErrorMessage(error, 'Failed to list directory'))
            }
        },
    )

    rpcHandlerManager.registerHandler<WorkspaceStatFilesRequest, StatFilesResponse>(
        RPC_METHODS.WorkspaceStatFiles,
        async (data) => {
            if (!Array.isArray(data.paths) || data.paths.length > 500) {
                return rpcError('Invalid file paths')
            }
            if (!data.paths.every((path): path is string => typeof path === 'string')) {
                return rpcError('Invalid file paths')
            }

            const cwd = await resolveWorkspaceCwd(pathPolicy, data.cwd)
            if ('error' in cwd) {
                return rpcError(cwd.error)
            }

            const resolvedPaths: Array<{ requested: string; path: string }> = []
            for (const requested of data.paths) {
                const path = await pathPolicy.resolveForCheck(resolve(cwd.cwd, requested))
                if (!pathPolicy.isWithinSpawnRoots(path)) {
                    return rpcError(OUTSIDE_WORKSPACE_ERROR)
                }
                if (!isWithinRoot(cwd.cwd, path)) {
                    return rpcError(OUTSIDE_SESSION_WORKSPACE_ERROR)
                }
                resolvedPaths.push({ requested, path })
            }

            const entries = await Promise.all(resolvedPaths.map(async ({ requested, path }) => {
                try {
                    const stats = await stat(path)
                    const type: FileMetadataEntry['type'] = stats.isFile()
                        ? 'file'
                        : stats.isDirectory()
                            ? 'directory'
                            : 'other'
                    return {
                        path: requested,
                        type,
                        size: stats.size,
                        modified: stats.mtime.getTime(),
                    }
                } catch {
                    return { path: requested }
                }
            }))

            return { success: true, entries }
        },
    )

    rpcHandlerManager.registerHandler<WorkspaceGitStatusRequest, CommandResponse>(
        RPC_METHODS.WorkspaceGitStatus,
        async (data) => {
            const resolved = await resolveWorkspaceCwd(pathPolicy, data.cwd)
            if ('error' in resolved) {
                return rpcError(resolved.error)
            }

            try {
                return await runGitCommand(
                    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--', '.'],
                    resolved.cwd,
                    data.timeout,
                )
            } catch (error) {
                return rpcError(getErrorMessage(error, 'Command failed'))
            }
        },
    )

    rpcHandlerManager.registerHandler<WorkspaceGitDiffNumstatRequest, CommandResponse>(
        RPC_METHODS.WorkspaceGitDiffNumstat,
        async (data) => {
            const resolved = await resolveWorkspaceCwd(pathPolicy, data.cwd)
            if ('error' in resolved) {
                return rpcError(resolved.error)
            }

            const args = data.staged
                ? ['diff', '--cached', '--numstat', '--', '.']
                : ['diff', '--numstat', '--', '.']
            try {
                return await runGitCommand(args, resolved.cwd, data.timeout)
            } catch (error) {
                return rpcError(getErrorMessage(error, 'Command failed'))
            }
        },
    )

    rpcHandlerManager.registerHandler<WorkspaceGitDiffFileRequest, CommandResponse>(
        RPC_METHODS.WorkspaceGitDiffFile,
        async (data) => {
            const filePath = typeof data.filePath === 'string' ? data.filePath : ''
            const resolved = await resolveWorkspacePath(pathPolicy, data.cwd, filePath)
            if ('error' in resolved) {
                return rpcError(resolved.error)
            }

            const args = data.staged
                ? ['--literal-pathspecs', 'diff', '--cached', '--no-ext-diff', '--', filePath]
                : ['--literal-pathspecs', 'diff', '--no-ext-diff', '--', filePath]
            try {
                return await runGitCommand(args, resolved.cwd, data.timeout)
            } catch (error) {
                return rpcError(getErrorMessage(error, 'Command failed'))
            }
        },
    )

    rpcHandlerManager.registerHandler<WorkspaceRipgrepRequest, CommandResponse>(
        RPC_METHODS.WorkspaceRipgrep,
        async (data) => {
            if (!Array.isArray(data.args) || !data.args.every((arg): arg is string => typeof arg === 'string')) {
                return rpcError('Invalid ripgrep arguments')
            }

            const resolved = await resolveWorkspaceCwd(pathPolicy, data.cwd)
            if ('error' in resolved) {
                return rpcError(resolved.error)
            }

            try {
                const result = data.fileSearch
                    ? await runFileSearch(data.args, { ...data.fileSearch, cwd: resolved.cwd })
                    : await runRipgrep(data.args, { cwd: resolved.cwd })
                return {
                    success: true,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                }
            } catch (error) {
                return rpcError(getErrorMessage(error, 'Failed to run ripgrep'))
            }
        },
    )

    rpcHandlerManager.registerHandler<WorkspaceWriteFileRequest, WorkspaceWriteFileResponse>(
        RPC_METHODS.WorkspaceWriteFile,
        async (data) => await handleWorkspaceWriteFile(pathPolicy, data),
    )

    rpcHandlerManager.registerHandler<WorkspaceDeletePathRequest, { success: boolean; error?: string }>(
        RPC_METHODS.WorkspaceDeletePath,
        async (data) => await handleWorkspaceDeletePath(pathPolicy, data),
    )
}
