import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listCodexModels,
    type ListCodexModelsRequest,
    type ListCodexModelsResponse
} from '../codexModels';
import {
    getCodexSubscriptionLimits,
    type GetCodexSubscriptionLimitsRequest,
    type GetCodexSubscriptionLimitsResponse
} from '../codexSubscriptionLimits';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerCodexModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListCodexModelsRequest, ListCodexModelsResponse>(RPC_METHODS.ListCodexModels, async (data) => {
        logger.debug('List Codex models request');

        try {
            const models = await listCodexModels(data?.includeHidden === true);
            return { success: true, models };
        } catch (error) {
            logger.debug('Failed to list Codex models:', error);
            return rpcError(getErrorMessage(error, 'Failed to list Codex models'));
        }
    });

    rpcHandlerManager.registerHandler<GetCodexSubscriptionLimitsRequest, GetCodexSubscriptionLimitsResponse>(
        RPC_METHODS.GetCodexSubscriptionLimits,
        async (data) => {
            logger.debug('Get Codex subscription limits request');

            try {
                const limits = await getCodexSubscriptionLimits(data?.model);
                return { success: true, limits };
            } catch (error) {
                logger.debug('Failed to read Codex subscription limits:', error);
                return rpcError(getErrorMessage(error, 'Failed to read Codex subscription limits'));
            }
        }
    );
}
