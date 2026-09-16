import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import {
    listKimiModelsForCwd,
    type ListKimiModelsForCwdRequest,
    type ListKimiModelsForCwdResponse
} from '../kimiModels'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerKimiModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListKimiModelsForCwdRequest, ListKimiModelsForCwdResponse>(
        RPC_METHODS.ListKimiModelsForCwd,
        async (data) => {
            try {
                return await listKimiModelsForCwd(typeof data?.cwd === 'string' ? data.cwd : '')
            } catch (error) {
                logger.debug('Failed to list Kimi models:', error)
                return rpcError(getErrorMessage(error, 'Failed to list Kimi models'))
            }
        }
    )
}
