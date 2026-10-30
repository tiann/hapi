import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { ListKimiModelsResponse } from '@hapi/protocol/apiTypes'
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

/**
 * Session-scoped discovery for a running Kimi session. The probe cwd is the
 * session's own metadata, never an RPC argument, so this cannot be pointed at
 * an arbitrary directory.
 */
export function registerKimiSessionModelHandlers(
    rpcHandlerManager: RpcHandlerManager,
    getCwd: () => string
): void {
    rpcHandlerManager.registerHandler<unknown, ListKimiModelsResponse>(
        RPC_METHODS.ListKimiModels,
        async () => {
            try {
                return await listKimiModelsForCwd(getCwd())
            } catch (error) {
                logger.debug('Failed to list Kimi models:', error)
                return rpcError(getErrorMessage(error, 'Failed to list Kimi models'))
            }
        }
    )
}
