import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { execFile, type ExecFileOptions } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const GIT_STATUS_TTL = 5_000
const MAX_TEXT_SAMPLE_BYTES = 512
const MAX_FILE_BYTES = 5 * 1024 * 1024
const PROJECT_SCAN_DEPTH = 3

type EditorGitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

type EditorDirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
    gitStatus?: EditorGitStatus
}

type EditorListDirectoryRequest = {
    path?: string
}

type EditorReadFileRequest = {
    path?: string
}

type EditorFileMutationRequest = {
    path?: string
    content?: string
}

type EditorGitStatusRequest = {
    path?: string
}

type EditorCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

type EditorProjectsResponse = {
    success: boolean
    projects?: Array<{ path: string; name: string; hasGit: boolean }>
    error?: string
}

type EditorFileMutationResponse = {
    success: boolean
    path?: string
    size?: number
    error?: string
}

const gitStatusCache = new Map<string, { timestamp: number; statuses: Map<string, EditorGitStatus> }>()
const execGit = execFileAsync as (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>

function rpcError<T extends object = object>(error: string, extra?: T): { success: false; error: string } & T {
    return { success: false, error, ...(extra ?? {} as T) }
}

function isWithinRoot(absolutePath: string, root: string): boolean {
    const rel = relative(root, absolutePath)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function normalizeRoot(rootDir: string): Promise<string> {
    const resolvedRoot = resolve(rootDir)
    try {
        return await realpath(resolvedRoot)
    } catch {
        return resolvedRoot
    }
}

async function resolveExistingInsideRoot(rawPath: string | undefined, rootDir: string): Promise<{ path: string; error?: string }> {
    const root = await normalizeRoot(rootDir)
    const target = resolve(root, rawPath && rawPath.trim() ? rawPath : root)

    let resolvedTarget: string
    try {
        resolvedTarget = await realpath(target)
    } catch {
        resolvedTarget = target
    }

    if (!isWithinRoot(resolvedTarget, root)) {
        return { path: resolvedTarget, error: 'Path outside editor root' }
    }

    return { path: resolvedTarget }
}

async function findNearestExistingPath(path: string): Promise<string> {
    let current = path
    while (true) {
        try {
            await stat(current)
            return current
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOENT') {
                throw error
            }
        }

        const parent = dirname(current)
        if (parent === current) {
            return current
        }
        current = parent
    }
}

async function resolveNewFileInsideRoot(rawPath: string | undefined, rootDir: string): Promise<{ path: string; error?: string }> {
    if (!rawPath?.trim()) {
        return { path: '', error: 'Path is required' }
    }

    const root = await normalizeRoot(rootDir)
    const target = resolve(root, rawPath.trim())
    if (!isWithinRoot(target, root)) {
        return { path: target, error: 'Path outside editor root' }
    }

    try {
        await stat(target)
        return { path: target, error: 'File already exists' }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
            return { path: target, error: getErrorMessage(error, 'Failed to check file') }
        }
    }

    const parent = dirname(target)
    try {
        const nearestExisting = await findNearestExistingPath(parent)
        const nearestReal = await realpath(nearestExisting)
        if (!isWithinRoot(nearestReal, root)) {
            return { path: target, error: 'Path outside editor root' }
        }

        await mkdir(parent, { recursive: true })
        const parentReal = await realpath(parent)
        if (!isWithinRoot(parentReal, root)) {
            return { path: target, error: 'Path outside editor root' }
        }
    } catch (error) {
        return { path: target, error: getErrorMessage(error, 'Failed to prepare parent directory') }
    }

    return { path: target }
}

function mapGitStatus(code: string): EditorGitStatus {
    if (code === '??') return 'untracked'
    if (code.includes('R')) return 'renamed'
    if (code.includes('A')) return 'added'
    if (code.includes('D')) return 'deleted'
    return 'modified'
}

function parseGitStatus(output: string): Map<string, EditorGitStatus> {
    const statuses = new Map<string, EditorGitStatus>()
    for (const line of output.split('\n')) {
        if (!line) continue
        const code = line.slice(0, 2).trim() || line.slice(0, 2)
        const rawPath = line.slice(3).trim()
        if (!rawPath) continue
        const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath
        statuses.set(filePath, mapGitStatus(code))
    }
    return statuses
}

async function getGitStatuses(cwd: string): Promise<Map<string, EditorGitStatus>> {
    const cached = gitStatusCache.get(cwd)
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_TTL) {
        return cached.statuses
    }

    try {
        const { stdout } = await execGit('git', ['status', '--porcelain'], {
            cwd,
            timeout: 3_000,
            encoding: 'utf8'
        })
        const statuses = parseGitStatus(stdout.toString())
        gitStatusCache.set(cwd, { timestamp: Date.now(), statuses })
        return statuses
    } catch {
        const statuses = new Map<string, EditorGitStatus>()
        gitStatusCache.set(cwd, { timestamp: Date.now(), statuses })
        return statuses
    }
}

async function isTextFile(path: string): Promise<boolean> {
    const content = await readFile(path)
    if (content.length === 0) return true
    const sample = content.subarray(0, Math.min(MAX_TEXT_SAMPLE_BYTES, content.length))
    return !sample.includes(0)
}

async function hasGitDirectory(path: string): Promise<boolean> {
    try {
        const gitStat = await stat(join(path, '.git'))
        return gitStat.isDirectory() || gitStat.isFile()
    } catch {
        return false
    }
}

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback
}

export function registerEditorRpcHandlers(rpcHandlerManager: RpcHandlerManager, editorRoot: string): void {
    rpcHandlerManager.registerHandler<EditorListDirectoryRequest>('editor-list-directory', async (data) => {
        const resolved = await resolveExistingInsideRoot(data?.path, editorRoot)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        try {
            const dirStat = await stat(resolved.path)
            if (!dirStat.isDirectory()) {
                return rpcError('Path is not a directory')
            }

            const [entries, gitStatuses] = await Promise.all([
                readdir(resolved.path, { withFileTypes: true }),
                getGitStatuses(resolved.path)
            ])

            const result: EditorDirectoryEntry[] = []
            await Promise.all(entries.map(async (entry) => {
                if (entry.name.startsWith('.')) return

                const fullPath = join(resolved.path, entry.name)
                let type: EditorDirectoryEntry['type'] = 'other'
                let size: number | undefined
                let modified: number | undefined

                if (entry.isDirectory()) {
                    type = 'directory'
                } else if (entry.isFile()) {
                    type = 'file'
                }

                if (!entry.isSymbolicLink()) {
                    try {
                        const entryStat = await stat(fullPath)
                        size = entryStat.size
                        modified = entryStat.mtime.getTime()
                    } catch {
                        // skip stat details on permission races
                    }
                }

                result.push({
                    name: entry.name,
                    type,
                    size,
                    modified,
                    gitStatus: gitStatuses.get(entry.name)
                })
            }))

            result.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1
                if (a.type !== 'directory' && b.type === 'directory') return 1
                return a.name.localeCompare(b.name)
            })

            return { success: true, entries: result }
        } catch (error) {
            return rpcError(getErrorMessage(error, 'Failed to list directory'))
        }
    })

    rpcHandlerManager.registerHandler<EditorReadFileRequest>('editor-read-file', async (data) => {
        const resolved = await resolveExistingInsideRoot(data?.path, editorRoot)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        try {
            const fileStat = await stat(resolved.path)
            if (!fileStat.isFile()) {
                return rpcError('Path is not a file')
            }
            if (fileStat.size > MAX_FILE_BYTES) {
                return rpcError('File is too large to read')
            }
            if (!await isTextFile(resolved.path)) {
                return rpcError('Cannot read binary file')
            }

            const content = await readFile(resolved.path)
            return {
                success: true,
                content: content.toString('base64'),
                size: content.length
            }
        } catch (error) {
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<EditorFileMutationRequest, EditorFileMutationResponse>('editor-write-file', async (data) => {
        if (typeof data?.content !== 'string') {
            return rpcError('Content must be a string')
        }

        const resolved = await resolveExistingInsideRoot(data.path, editorRoot)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        try {
            const fileStat = await stat(resolved.path)
            if (!fileStat.isFile()) {
                return rpcError('Path is not a file')
            }
            const size = Buffer.byteLength(data.content, 'utf8')
            if (size > MAX_FILE_BYTES) {
                return rpcError('File is too large to write')
            }

            await writeFile(resolved.path, data.content, 'utf8')
            return {
                success: true,
                path: resolved.path,
                size
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT') {
                return rpcError('File does not exist')
            }
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })

    rpcHandlerManager.registerHandler<EditorFileMutationRequest, EditorFileMutationResponse>('editor-create-file', async (data) => {
        if (typeof data?.content !== 'string') {
            return rpcError('Content must be a string')
        }

        const resolved = await resolveNewFileInsideRoot(data.path, editorRoot)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        try {
            const size = Buffer.byteLength(data.content, 'utf8')
            if (size > MAX_FILE_BYTES) {
                return rpcError('File is too large to write')
            }

            await writeFile(resolved.path, data.content, { encoding: 'utf8', flag: 'wx' })
            return {
                success: true,
                path: resolved.path,
                size
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EEXIST') {
                return rpcError('File already exists')
            }
            return rpcError(getErrorMessage(error, 'Failed to create file'))
        }
    })

    rpcHandlerManager.registerHandler<EditorReadFileRequest, EditorFileMutationResponse>('editor-delete-file', async (data) => {
        const resolved = await resolveExistingInsideRoot(data?.path, editorRoot)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        try {
            const fileStat = await stat(resolved.path)
            if (!fileStat.isFile()) {
                return rpcError('Path is not a file')
            }

            await rm(resolved.path)
            return {
                success: true,
                path: resolved.path
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT') {
                return rpcError('File does not exist')
            }
            return rpcError(getErrorMessage(error, 'Failed to delete file'))
        }
    })

    rpcHandlerManager.registerHandler('editor-list-projects', async (): Promise<EditorProjectsResponse> => {
        const root = await normalizeRoot(editorRoot)
        const projects = new Map<string, { path: string; name: string; hasGit: boolean }>()
        const skipDirs = new Set([
            'node_modules', '.git', 'Library', 'Applications', 'Desktop', 'Downloads',
            'Documents', 'Music', 'Pictures', 'Videos', '.cache', '.npm', '.cargo',
            '.local', '.m2', '.gradle'
        ])

        async function addProject(path: string, hasGit: boolean): Promise<void> {
            projects.set(path, { path, name: basename(path) || path, hasGit })
        }

        async function scanDir(dir: string, depth: number): Promise<void> {
            if (depth > PROJECT_SCAN_DEPTH) return
            if (!isWithinRoot(dir, root)) return

            const dirHasGit = await hasGitDirectory(dir)
            if (dirHasGit || depth <= 2) {
                await addProject(dir, dirHasGit)
            }

            let entries: Dirent<string>[]
            try {
                entries = await readdir(dir, { withFileTypes: true })
            } catch {
                return
            }

            await Promise.all(entries.map(async (entry) => {
                if (!entry.isDirectory()) return
                if (skipDirs.has(entry.name) || entry.name.startsWith('.')) return
                const childPath = join(dir, entry.name)
                await scanDir(childPath, depth + 1)
            }))
        }

        try {
            await scanDir(root, 0)
            const sortedProjects = [...projects.values()].sort((a, b) => {
                if (a.hasGit !== b.hasGit) return a.hasGit ? -1 : 1
                return a.name.localeCompare(b.name)
            })
            return { success: true, projects: sortedProjects }
        } catch (error) {
            return rpcError(getErrorMessage(error, 'Failed to list projects'))
        }
    })

    rpcHandlerManager.registerHandler<EditorGitStatusRequest, EditorCommandResponse>('editor-git-status', async (data) => {
        const resolved = await resolveExistingInsideRoot(data?.path, editorRoot)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        try {
            const { stdout, stderr } = await execGit('git', ['status', '--porcelain'], {
                cwd: resolved.path,
                timeout: 5_000,
                encoding: 'utf8'
            })
            return {
                success: true,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                exitCode: 0
            }
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string }
            return rpcError(execError.message || 'Git status failed', {
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Git status failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1
            })
        }
    })
}
