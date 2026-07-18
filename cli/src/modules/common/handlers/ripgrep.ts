import { logger } from '@/ui/logger'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { run as runRipgrep } from '@/modules/ripgrep/index'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface RipgrepRequest {
    args: string[]
    cwd?: string
}

interface RipgrepResponse {
    success: boolean
    exitCode?: number
    stdout?: string
    stderr?: string
    error?: string
}

function validateFileListingArgs(args: unknown): string | null {
    if (!Array.isArray(args)) {
        return 'Invalid ripgrep arguments'
    }

    let sawFilesMode = false
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]
        if (argument === '--files' && !sawFilesMode) {
            sawFilesMode = true
            continue
        }
        if (argument === '--iglob' && typeof args[index + 1] === 'string') {
            index += 1
            continue
        }
        return `Unsupported ripgrep argument: ${String(argument)}`
    }

    return sawFilesMode ? null : 'Ripgrep handler only supports workspace file listing'
}

export function registerRipgrepHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd)

        const argsError = validateFileListingArgs(data.args)
        if (argsError) {
            return rpcError(argsError)
        }

        const validation = await validatePath(data.cwd ?? workingDirectory, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid working directory')
        }

        try {
            const result = await runRipgrep(data.args, { cwd: validation.resolvedPath })
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            }
        } catch (error) {
            logger.debug('Failed to run ripgrep:', error)
            return rpcError(getErrorMessage(error, 'Failed to run ripgrep'))
        }
    })
}
