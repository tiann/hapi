import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listAgyModels,
    type ListAgyModelsResponse
} from '../agyModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerAgyModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<Record<string, never>, ListAgyModelsResponse>(
        RPC_METHODS.ListAgyModels,
        async () => {
            logger.debug('List Agy models request');

            try {
                return await listAgyModels();
            } catch (error) {
                logger.debug('Failed to list Agy models:', error);
                return rpcError(getErrorMessage(error, 'Failed to list Agy models'));
            }
        }
    );
}
