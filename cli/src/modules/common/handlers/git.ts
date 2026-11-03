import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'
import type { CommandResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { rpcError } from '../rpcResponses'

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

type GitCommandResponse = CommandResponse

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

export async function runGitCommand(
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
            return rpcError('Command timed out', {
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : '',
                exitCode: typeof execError.code === 'number' ? execError.code : -1
            })
        }

        return rpcError(execError.message || 'Command failed', {
            stdout: execError.stdout ? execError.stdout.toString() : '',
            stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
            exitCode: typeof execError.code === 'number' ? execError.code : 1
        })
    }
}

export function registerGitHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitStatusRequest, GitCommandResponse>(RPC_METHODS.GitStatus, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }
        return await runGitCommand(
            ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
            resolved.cwd,
            data.timeout
        )
    })

    rpcHandlerManager.registerHandler<GitDiffNumstatRequest, GitCommandResponse>(RPC_METHODS.GitDiffNumstat, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }
        const args = data.staged
            ? ['diff', '--cached', '--numstat']
            : ['diff', '--numstat']
        return await runGitCommand(args, resolved.cwd, data.timeout)
    })

    rpcHandlerManager.registerHandler<GitDiffFileRequest, GitCommandResponse>(RPC_METHODS.GitDiffFile, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }
        const fileError = validateFilePath(data.filePath, workingDirectory)
        if (fileError) {
            return rpcError(fileError)
        }

        const args = data.staged
            ? ['diff', '--cached', '--no-ext-diff', '--', data.filePath]
            : ['diff', '--no-ext-diff', '--', data.filePath]
        return await runGitCommand(args, resolved.cwd, data.timeout)
    })
}
