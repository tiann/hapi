import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { run as runRipgrep, runFileSearch, type FileSearchOptions } from '@/modules/ripgrep/index'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface RipgrepRequest {
    args: string[]
    cwd?: string
    fileSearch?: FileSearchOptions
}

interface RipgrepResponse {
    success: boolean
    exitCode?: number
    stdout?: string
    stderr?: string
    error?: string
}

export function registerRipgrepHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>(RPC_METHODS.Ripgrep, async (data) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd)

        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory)
            if (!validation.valid) {
                return rpcError(validation.error ?? 'Invalid working directory')
            }
        }

        try {
            const result = data.fileSearch
                ? await runFileSearch(data.args, { ...data.fileSearch, cwd: data.cwd })
                : await runRipgrep(data.args, { cwd: data.cwd })
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
