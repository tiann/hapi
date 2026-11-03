import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listClaudeModels,
    type ListClaudeModelsRequest,
    type ListClaudeModelsResponse
} from '../claudeModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerClaudeModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListClaudeModelsRequest, ListClaudeModelsResponse>(
        RPC_METHODS.ListClaudeModels,
        async () => {
            logger.debug('List Claude models request');

            try {
                return await listClaudeModels();
            } catch (error) {
                logger.debug('Failed to list Claude models:', error);
                return rpcError(getErrorMessage(error, 'Failed to list Claude models'));
            }
        }
    );
}
