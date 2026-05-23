import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { listSkills, type ListSkillsRequest, type ListSkillsResponse } from '../skills'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerSkillsHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ListSkillsRequest, ListSkillsResponse>(RPC_METHODS.ListSkills, async (request) => {
        logger.debug('List skills request')

        try {
            const skills = await listSkills(workingDirectory, { flavor: request.flavor })
            return { success: true, skills }
        } catch (error) {
            logger.debug('Failed to list skills:', error)
            return rpcError(getErrorMessage(error, 'Failed to list skills'))
        }
    })
}
