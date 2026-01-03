import { logger } from '@/ui/logger'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { listSlashCommands, type ListSlashCommandsRequest, type ListSlashCommandsResponse } from '../slashCommands'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerSlashCommandHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListSlashCommandsRequest, ListSlashCommandsResponse>('listSlashCommands', async (data) => {
        logger.debug('List slash commands request for agent:', data.agent)

        try {
            const commands = await listSlashCommands(data.agent)
            return { success: true, commands }
        } catch (error) {
            logger.debug('Failed to list slash commands:', error)
            return rpcError(getErrorMessage(error, 'Failed to list slash commands'))
        }
    })
}
