import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listAgyModels,
    type ListAgyModelsResponse
} from '../agyModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerAgyModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<{ refresh?: boolean } | null, ListAgyModelsResponse>(
        RPC_METHODS.ListAgyModels,
        async (params) => {
            logger.debug('List Agy models request');

            try {
                // A hub that predates the flag sends none, and only an explicit
                // refresh should cost another agy invocation.
                return await listAgyModels({ refresh: params?.refresh === true });
            } catch (error) {
                logger.debug('Failed to list Agy models:', error);
                return rpcError(getErrorMessage(error, 'Failed to list Agy models'));
            }
        }
    );
}
