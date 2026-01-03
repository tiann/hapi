import { logger } from '@/ui/logger'
import { exec, type ExecOptions } from 'child_process'
import { promisify } from 'util'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

const execAsync = promisify(exec)

interface BashRequest {
    command: string
    cwd?: string
    timeout?: number
}

interface BashResponse {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export function registerBashHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
        logger.debug('Shell command request:', data.command)

        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory)
            if (!validation.valid) {
                return rpcError(validation.error ?? 'Invalid working directory')
            }
        }

        try {
            const options: ExecOptions = {
                cwd: data.cwd,
                timeout: data.timeout || 30000
            }

            const { stdout, stderr } = await execAsync(data.command, options)

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

            return rpcError(getErrorMessage(execError, 'Command failed'), {
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1
            })
        }
    })
}
