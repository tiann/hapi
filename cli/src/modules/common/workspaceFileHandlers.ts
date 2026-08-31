import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
    CommandResponse,
    DirectoryEntry,
    FileReadResponse,
    ListDirectoryResponse,
    StatFilesResponse,
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

type ResolvedWorkspaceCwd = { cwd: string } | { error: string }
type ResolvedWorkspacePath = { cwd: string; path: string } | { error: string }

const OUTSIDE_WORKSPACE_ERROR = 'Path is outside workspace roots'
const OUTSIDE_SESSION_WORKSPACE_ERROR = 'Path is outside the session workspace'
export const MAX_WORKSPACE_FILE_BYTES = MAX_GENERATED_IMAGE_BYTES

function isWithinRoot(root: string, target: string): boolean {
    const child = relative(root, target)
    return child === '' || (!child.startsWith('..') && !isAbsolute(child))
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

/**
 * Register read-only workspace operations on the machine-scoped runner
 * socket. These are deliberately separate from session-scoped RPCs so an
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
                const buffer = await readBoundedRegularFile(resolved.path, MAX_WORKSPACE_FILE_BYTES)
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
                    return {
                        path: requested,
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
                    ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
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
                ? ['diff', '--cached', '--numstat']
                : ['diff', '--numstat']
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
                ? ['diff', '--cached', '--no-ext-diff', '--', filePath]
                : ['diff', '--no-ext-diff', '--', filePath]
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
}
