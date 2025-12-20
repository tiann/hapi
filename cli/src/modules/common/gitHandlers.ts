import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager'
import { validatePath } from './pathSecurity'

const execFileAsync = promisify(execFile)

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

function resolveCwd(requestedCwd: string | undefined, workingDirectory: string): { cwd: string; error?: string } {
    const cwd = requestedCwd ?? workingDirectory
    const validation = validatePath(cwd, workingDirectory)
    if (!validation.valid) {
        return { cwd, error: validation.error ?? 'Invalid working directory' }
    }
    return { cwd }
}

function validateFilePath(filePath: string, workingDirectory: string): string | null {
    const validation = validatePath(filePath, workingDirectory)
    if (!validation.valid) {
        return validation.error ?? 'Invalid file path'
    }
    return null
}

async function runGitCommand(
    args: string[],
    cwd: string,
    timeout?: number
): Promise<GitCommandResponse> {
    try {
        const options: ExecFileOptions = {
            cwd,
            timeout: timeout ?? 10_000
        }
        const { stdout, stderr } = await execFileAsync('git', args, options)
        return {
            success: true,
            stdout: stdout ? stdout.toString() : '',
            stderr: stderr ? stderr.toString() : '',
            exitCode: 0
        }
    } catch (error) {
        const execError = error as NodeJS.ErrnoException & {
            stdout?: string
            stderr?: string
            code?: number | string
            killed?: boolean
        }

        if (execError.code === 'ETIMEDOUT' || execError.killed) {
            return {
                success: false,
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : '',
                exitCode: typeof execError.code === 'number' ? execError.code : -1,
                error: 'Command timed out'
            }
        }

        return {
            success: false,
            stdout: execError.stdout ? execError.stdout.toString() : '',
            stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
            exitCode: typeof execError.code === 'number' ? execError.code : 1,
            error: execError.message || 'Command failed'
        }
    }
}

export function registerGitHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitStatusRequest, GitCommandResponse>('git-status', async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return { success: false, error: resolved.error }
        }
        return await runGitCommand(
            ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
            resolved.cwd,
            data.timeout
        )
    })

    rpcHandlerManager.registerHandler<GitDiffNumstatRequest, GitCommandResponse>('git-diff-numstat', async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return { success: false, error: resolved.error }
        }
        const args = data.staged
            ? ['diff', '--cached', '--numstat']
            : ['diff', '--numstat']
        return await runGitCommand(args, resolved.cwd, data.timeout)
    })

    rpcHandlerManager.registerHandler<GitDiffFileRequest, GitCommandResponse>('git-diff-file', async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return { success: false, error: resolved.error }
        }
        const fileError = validateFilePath(data.filePath, workingDirectory)
        if (fileError) {
            return { success: false, error: fileError }
        }

        const args = data.staged
            ? ['diff', '--cached', '--no-ext-diff', '--', data.filePath]
            : ['diff', '--no-ext-diff', '--', data.filePath]
        return await runGitCommand(args, resolved.cwd, data.timeout)
    })
}
