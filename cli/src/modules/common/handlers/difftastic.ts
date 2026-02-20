import { logger } from '@/ui/logger'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { run as runDifftastic } from '@/modules/difftastic/index'
import { validateDifftasticArgs } from '../argSecurity'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface DifftasticRequest {
    args: string[]
    cwd?: string
}

interface DifftasticResponse {
    success: boolean
    exitCode?: number
    stdout?: string
    stderr?: string
    error?: string
}

export function registerDifftasticHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd)

        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory)
            if (!validation.valid) {
                return rpcError(validation.error ?? 'Invalid working directory')
            }
        }

        const argValidation = validateDifftasticArgs(data.args)
        if (!argValidation.valid) {
            return rpcError(argValidation.error ?? 'Invalid difftastic arguments')
        }

        try {
            const result = await runDifftastic(data.args, { cwd: data.cwd })
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            }
        } catch (error) {
            logger.debug('Failed to run difftastic:', error)
            return rpcError(getErrorMessage(error, 'Failed to run difftastic'))
        }
    })
}
