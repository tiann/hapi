import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { run as runRipgrep, runFileSearch, type FileSearchOptions } from '@/modules/ripgrep/index'
import { resolveRealPathWithinWorkingDirectory } from '../pathSecurity'
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

        const requestedCwd = data.cwd ?? workingDirectory
        const safeCwd = await resolveRealPathWithinWorkingDirectory(requestedCwd, workingDirectory)
        if (!safeCwd) {
            return rpcError('Invalid working directory')
        }

        if (data.fileSearch) {
            const separatorIndex = data.args.indexOf('--')
            if (separatorIndex >= 0) {
                for (const searchPath of data.args.slice(separatorIndex + 1)) {
                    if (!await resolveRealPathWithinWorkingDirectory(searchPath, safeCwd)) {
                        return rpcError('Invalid file search path')
                    }
                }
            }
        }

        try {
            const result = data.fileSearch
                ? await runFileSearch(data.args, { ...data.fileSearch, cwd: safeCwd })
                : await runRipgrep(data.args, { cwd: safeCwd })
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
