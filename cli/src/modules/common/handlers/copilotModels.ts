import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listCopilotModelsForCwd,
    type ListCopilotModelsForCwdRequest,
    type ListCopilotModelsForCwdResponse
} from '../copilotModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerCopilotModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListCopilotModelsForCwdRequest, ListCopilotModelsForCwdResponse>(
        RPC_METHODS.ListCopilotModelsForCwd,
        async (data) => {
            try {
                return await listCopilotModelsForCwd(typeof data?.cwd === 'string' ? data.cwd : '');
            } catch (error) {
                logger.debug('Failed to list Copilot models:', error);
                return rpcError(getErrorMessage(error, 'Failed to list Copilot models'));
            }
        }
    );
}
