import { logger } from '@/ui/logger'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { listMentions, type ListMentionsRequest, type ListMentionsResponse } from '../mentions'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerMentionHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListMentionsRequest, ListMentionsResponse>('listMentions', async (data) => {
        logger.debug('List mentions request for agent:', data.agent)

        try {
            const mentions = await listMentions(data)
            return { success: true, mentions }
        } catch (error) {
            logger.debug('Failed to list mentions:', error)
            return rpcError(getErrorMessage(error, 'Failed to list mentions'))
        }
    })
}
