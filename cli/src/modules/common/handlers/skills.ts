import { logger } from '@/ui/logger'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { listSkills, type ListSkillsRequest, type ListSkillsResponse } from '../skills'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerSkillsHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ListSkillsRequest, ListSkillsResponse>('listSkills', async (data) => {
        logger.debug('List skills request')

        try {
            const skills = await listSkills(workingDirectory, { agent: data.agent })
            return { success: true, skills }
        } catch (error) {
            logger.debug('Failed to list skills:', error)
            return rpcError(getErrorMessage(error, 'Failed to list skills'))
        }
    })
}
