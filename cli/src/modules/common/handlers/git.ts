import { execFile, spawn, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'
import { lstat, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { devNull } from 'node:os'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { rpcError } from '../rpcResponses'

const execFileAsync = promisify(execFile)
const SAFE_GIT_PREFIX = ['--no-optional-locks', '-c', 'core.fsmonitor=false'] as const
const SAFE_GIT_DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--submodule=short'] as const
const CONTENT_FILTER_ERROR = 'Git repository content filters are not allowed'
const REPOSITORY_CONFIG_ERROR = 'Git repository configuration is unavailable'
const SUBMODULE_CONFIG_ERROR = 'Git submodule configuration is unavailable'
const GIT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024
const GIT_INDEX_MAX_BYTES = 64 * 1024 * 1024
const MAX_GIT_REPOSITORIES = 256
const MAX_GIT_REPOSITORY_DEPTH = 32
const DEFAULT_GIT_TIMEOUT_MS = 10_000
const MAX_GIT_TIMEOUT_MS = 25_000
const GITLINK_INDEX_PREFIX = Buffer.from('160000 ')

interface GitCommandBudget {
    deadline: number
}

interface GitInspectionState {
    visited: Set<string>
    discoveredGitlinks: number
}

export function gitEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        // Repository, index, object, executable, transport, config, and prompt
        // overrides must never escape the session workspace through ambient
        // process state. Add back only the fixed safety controls below.
        if (key.toUpperCase().startsWith('GIT_')) delete env[key]
    }
    return {
        ...env,
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
    }
}

function createGitCommandBudget(timeout: number | undefined): GitCommandBudget {
    const requested = typeof timeout === 'number' && Number.isFinite(timeout)
        ? Math.trunc(timeout)
        : DEFAULT_GIT_TIMEOUT_MS
    const duration = Math.min(MAX_GIT_TIMEOUT_MS, Math.max(1, requested))
    return { deadline: Date.now() + duration }
}

function remainingGitCommandTime(budget: GitCommandBudget): number {
    return Math.max(0, budget.deadline - Date.now())
}

interface GitStatusRequest {
    cwd?: string
    timeout?: number
}

interface GitDiffNumstatRequest {
    cwd?: string
    staged?: boolean
    timeout?: number
}

interface GitDiffFileRequest {
    cwd?: string
    filePath: string
    staged?: boolean
    timeout?: number
}

interface GitCommandResponse {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

async function resolveCwd(requestedCwd: string | undefined, workingDirectory: string): Promise<{ cwd: string; error?: string }> {
    const cwd = requestedCwd ?? workingDirectory
    const validation = await validatePath(cwd, workingDirectory)
    if (!validation.valid) {
        return { cwd, error: validation.error ?? 'Invalid working directory' }
    }
    return { cwd: validation.resolvedPath! }
}

async function resolveFilePath(filePath: string, workingDirectory: string): Promise<{ path?: string; error?: string }> {
    const validation = await validatePath(filePath, workingDirectory, { allowMissingDescendants: true })
    if (!validation.valid) {
        return { error: validation.error ?? 'Invalid file path' }
    }
    return { path: validation.resolvedPath! }
}

async function resolveGitCwd(
    requestedCwd: string | undefined,
    workingDirectory: string,
    budget: GitCommandBudget,
): Promise<{ cwd: string; repositoryRoot?: string; error?: string }> {
    const resolved = await resolveCwd(requestedCwd, workingDirectory)
    if (resolved.error) return resolved

    const repository = await runGitCommand(
        [...SAFE_GIT_PREFIX, 'rev-parse', '--show-toplevel'],
        resolved.cwd,
        budget,
    )
    if (!repository.success) {
        return {
            cwd: resolved.cwd,
            error: 'Git repository is unavailable',
        }
    }

    const repositoryRoot = repository.stdout?.trim()
    if (!repositoryRoot) {
        return { cwd: resolved.cwd, error: 'Git repository root is unavailable' }
    }
    const repositoryBoundary = await validatePath(repositoryRoot, workingDirectory)
    if (!repositoryBoundary.valid || !repositoryBoundary.resolvedPath) {
        return {
            cwd: resolved.cwd,
            error: 'Git repository root is outside the session workspace',
        }
    }

    // The requested cwd and --show-toplevel must rediscover the same Git
    // directory. A repository can point core.worktree at a contained directory
    // that has its own decoy .git; inspecting config from that top level while
    // running the final command from the original cwd would guard the wrong repo.
    const requestedIdentity = await resolveGitDirectoryIdentity(resolved.cwd, budget)
    const rootIdentity = await resolveGitDirectoryIdentity(repositoryBoundary.resolvedPath, budget)
    if (
        !requestedIdentity
        || !rootIdentity
        || requestedIdentity !== rootIdentity
    ) {
        return {
            cwd: resolved.cwd,
            error: REPOSITORY_CONFIG_ERROR,
        }
    }

    return {
        cwd: resolved.cwd,
        repositoryRoot: repositoryBoundary.resolvedPath,
    }
}

async function resolveGitDirectoryIdentity(
    cwd: string,
    budget: GitCommandBudget,
): Promise<string | undefined> {
    const directory = await runGitCommand(
        [...SAFE_GIT_PREFIX, 'rev-parse', '--absolute-git-dir'],
        cwd,
        budget,
    )
    const path = directory.success ? directory.stdout?.trim() : undefined
    if (!path) return undefined
    try {
        return await realpath(path)
    } catch {
        return undefined
    }
}

async function runGitCommand(
    args: string[],
    cwd: string,
    budget: GitCommandBudget,
): Promise<GitCommandResponse> {
    const timeout = remainingGitCommandTime(budget)
    if (timeout <= 0) return rpcError('Command timed out', { exitCode: -1 })
    try {
        const options: ExecFileOptions = {
            cwd,
            timeout,
            maxBuffer: GIT_COMMAND_MAX_BUFFER,
            env: gitEnvironment(),
        }
        const { stdout } = await execFileAsync('git', args, options)
        return {
            success: true,
            stdout: stdout ? stdout.toString() : '',
            stderr: '',
            exitCode: 0
        }
    } catch (error) {
        const execError = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }

        if (execError.code === 'ETIMEDOUT' || execError.killed) {
            return rpcError('Command timed out', {
                exitCode: typeof execError.code === 'number' ? execError.code : -1
            })
        }

        return rpcError('Git command failed', {
            exitCode: typeof execError.code === 'number' ? execError.code : 1
        })
    }
}

async function listGitlinkPaths(
    cwd: string,
    budget: GitCommandBudget,
    maxPaths: number,
): Promise<{ paths?: Set<string>; error?: string }> {
    const timeout = remainingGitCommandTime(budget)
    if (timeout <= 0) return { error: SUBMODULE_CONFIG_ERROR }
    return await new Promise((resolve) => {
        const child = spawn('git', [...SAFE_GIT_PREFIX, 'ls-files', '--stage', '--full-name', '-z'], {
            cwd,
            env: gitEnvironment(),
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const paths = new Set<string>()
        let pending: Buffer = Buffer.alloc(0)
        let outputBytes = 0
        let failed = false
        let settled = false

        const finish = (result: { paths?: Set<string>; error?: string }): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }

        const failClosed = (): void => {
            if (failed) return
            failed = true
            child.kill('SIGKILL')
        }

        const timer = setTimeout(failClosed, timeout)
        timer.unref()
        child.stderr.resume()
        child.once('error', () => finish({ error: SUBMODULE_CONFIG_ERROR }))
        child.stdout.on('data', (chunk: Buffer) => {
            if (failed) return
            outputBytes += chunk.length
            if (outputBytes > GIT_INDEX_MAX_BYTES) {
                failClosed()
                return
            }
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
            let terminator = pending.indexOf(0)
            while (terminator >= 0) {
                const entry = pending.subarray(0, terminator)
                pending = pending.subarray(terminator + 1)
                if (entry.subarray(0, GITLINK_INDEX_PREFIX.length).equals(GITLINK_INDEX_PREFIX)) {
                    const separator = entry.indexOf(0x09)
                    if (separator < 0 || separator === entry.length - 1) {
                        failClosed()
                        return
                    }
                    const rawPath = entry.subarray(separator + 1)
                    const path = rawPath.toString('utf8')
                    if (!Buffer.from(path, 'utf8').equals(rawPath)) {
                        failClosed()
                        return
                    }
                    paths.add(path)
                    if (paths.size > maxPaths) {
                        failClosed()
                        return
                    }
                }
                terminator = pending.indexOf(0)
            }
        })
        child.stdout.once('error', failClosed)
        child.once('close', (code) => {
            if (failed || code !== 0 || pending.length !== 0) {
                finish({ error: SUBMODULE_CONFIG_ERROR })
                return
            }
            finish({ paths })
        })
    })
}

async function rejectConfiguredContentFilters(
    repositoryRoot: string,
    workingDirectory: string,
    budget: GitCommandBudget,
    state: GitInspectionState = { visited: new Set<string>(), discoveredGitlinks: 0 },
    depth = 0,
): Promise<string | undefined> {
    if (depth > MAX_GIT_REPOSITORY_DEPTH) return SUBMODULE_CONFIG_ERROR
    if (state.visited.has(repositoryRoot)) return undefined
    if (state.visited.size >= MAX_GIT_REPOSITORIES) return SUBMODULE_CONFIG_ERROR
    state.visited.add(repositoryRoot)

    // --no-textconv only disables diff textconv drivers. A normal worktree
    // diff can still execute filter.<driver>.clean/process from Git config, so
    // inspect every populated repository before asking Git to read worktree contents.
    const configured = await runGitCommand(
        [
            ...SAFE_GIT_PREFIX,
            'config',
            '--name-only',
            '--get-regexp',
            '^filter\\..*\\.(clean|process)$',
        ],
        repositoryRoot,
        budget,
    )
    if (configured.success) {
        if (configured.stdout?.trim()) return CONTENT_FILTER_ERROR
    } else if (configured.exitCode !== 1) {
        return REPOSITORY_CONFIG_ERROR
    }

    const index = await listGitlinkPaths(
        repositoryRoot,
        budget,
        MAX_GIT_REPOSITORIES - state.discoveredGitlinks,
    )
    if (index.error || !index.paths) return SUBMODULE_CONFIG_ERROR
    state.discoveredGitlinks += index.paths.size

    for (const submodulePath of index.paths) {
        const candidate = join(repositoryRoot, submodulePath)
        let stats: Awaited<ReturnType<typeof lstat>>
        try {
            stats = await lstat(candidate)
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException
            if (nodeError.code === 'ENOENT') continue
            return SUBMODULE_CONFIG_ERROR
        }
        if (stats.isSymbolicLink()) return SUBMODULE_CONFIG_ERROR
        if (!stats.isDirectory()) continue

        const childBoundary = await validatePath(candidate, workingDirectory)
        if (!childBoundary.valid || !childBoundary.resolvedPath) return SUBMODULE_CONFIG_ERROR
        const childRepository = await runGitCommand(
            [...SAFE_GIT_PREFIX, 'rev-parse', '--show-toplevel'],
            childBoundary.resolvedPath,
            budget,
        )
        if (!childRepository.success) return SUBMODULE_CONFIG_ERROR

        const childRoot = childRepository.stdout?.trim()
        if (!childRoot) return SUBMODULE_CONFIG_ERROR
        const childRootBoundary = await validatePath(childRoot, workingDirectory)
        if (!childRootBoundary.valid || !childRootBoundary.resolvedPath) return SUBMODULE_CONFIG_ERROR

        // An uninitialized submodule directory resolves to the repository that
        // contains the gitlink. Any other mismatch can redirect Git to a
        // different worktree, so fail closed rather than classifying it as
        // uninitialized.
        if (childRootBoundary.resolvedPath === repositoryRoot) continue
        if (childRootBoundary.resolvedPath !== childBoundary.resolvedPath) {
            return SUBMODULE_CONFIG_ERROR
        }
        const nestedError = await rejectConfiguredContentFilters(
            childRootBoundary.resolvedPath,
            workingDirectory,
            budget,
            state,
            depth + 1,
        )
        if (nestedError) return nestedError
    }

    return undefined
}

export function registerGitHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitStatusRequest, GitCommandResponse>('git-status', async (data) => {
        const budget = createGitCommandBudget(data.timeout)
        const resolved = await resolveGitCwd(data.cwd, workingDirectory, budget)
        if (resolved.error || !resolved.repositoryRoot) {
            return rpcError(resolved.error ?? 'Git repository root is unavailable')
        }
        const filterError = await rejectConfiguredContentFilters(
            resolved.repositoryRoot,
            workingDirectory,
            budget,
        )
        if (filterError) return rpcError(filterError)
        return await runGitCommand(
            [...SAFE_GIT_PREFIX, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'],
            resolved.cwd,
            budget,
        )
    })

    rpcHandlerManager.registerHandler<GitDiffNumstatRequest, GitCommandResponse>('git-diff-numstat', async (data) => {
        const budget = createGitCommandBudget(data.timeout)
        const resolved = await resolveGitCwd(data.cwd, workingDirectory, budget)
        if (resolved.error || !resolved.repositoryRoot) {
            return rpcError(resolved.error ?? 'Git repository root is unavailable')
        }
        if (!data.staged) {
            const filterError = await rejectConfiguredContentFilters(
                resolved.repositoryRoot,
                workingDirectory,
                budget,
            )
            if (filterError) return rpcError(filterError)
        }
        const args = data.staged
            ? [...SAFE_GIT_PREFIX, 'diff', '--cached', '--numstat', ...SAFE_GIT_DIFF_OPTIONS]
            : [...SAFE_GIT_PREFIX, 'diff', '--numstat', ...SAFE_GIT_DIFF_OPTIONS]
        return await runGitCommand(args, resolved.cwd, budget)
    })

    rpcHandlerManager.registerHandler<GitDiffFileRequest, GitCommandResponse>('git-diff-file', async (data) => {
        const budget = createGitCommandBudget(data.timeout)
        const resolved = await resolveGitCwd(data.cwd, workingDirectory, budget)
        if (resolved.error || !resolved.repositoryRoot) {
            return rpcError(resolved.error ?? 'Git repository root is unavailable')
        }
        const file = await resolveFilePath(data.filePath, workingDirectory)
        if (file.error || !file.path) {
            return rpcError(file.error ?? 'Invalid file path')
        }
        if (!data.staged) {
            const filterError = await rejectConfiguredContentFilters(
                resolved.repositoryRoot,
                workingDirectory,
                budget,
            )
            if (filterError) return rpcError(filterError)
        }

        const pathspec = relative(resolved.cwd, file.path) || '.'

        const args = data.staged
            ? [...SAFE_GIT_PREFIX, 'diff', '--cached', ...SAFE_GIT_DIFF_OPTIONS, '--', pathspec]
            : [...SAFE_GIT_PREFIX, 'diff', ...SAFE_GIT_DIFF_OPTIONS, '--', pathspec]
        return await runGitCommand(args, resolved.cwd, budget)
    })
}
