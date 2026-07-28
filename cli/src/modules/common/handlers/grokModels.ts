import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import {
    listGrokModelsForCwd,
    type ListGrokModelsForCwdRequest,
    type ListGrokModelsForCwdResponse
} from '../grokModels'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerGrokModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListGrokModelsForCwdRequest, ListGrokModelsForCwdResponse>(
        RPC_METHODS.ListGrokModelsForCwd,
        async (data) => {
            try {
                return await listGrokModelsForCwd(typeof data?.cwd === 'string' ? data.cwd : '')
            } catch (error) {
                logger.debug('Failed to list Grok models:', error)
                return rpcError(getErrorMessage(error, 'Failed to list Grok models'))
            }
        }
    )
}
