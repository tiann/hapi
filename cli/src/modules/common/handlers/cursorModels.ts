import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listCursorModels,
    type ListCursorModelsResponse
} from '../cursorModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerCursorModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<Record<string, never>, ListCursorModelsResponse>(
        RPC_METHODS.ListCursorModels,
        async () => {
            logger.debug('List Cursor models request');

            try {
                return await listCursorModels();
            } catch (error) {
                logger.debug('Failed to list Cursor models:', error);
                return rpcError(getErrorMessage(error, 'Failed to list Cursor models'));
            }
        }
    );
}
