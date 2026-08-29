import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listCodexModels,
    listCodexProfiles,
    listCodexProviders,
    type ListCodexModelsRequest,
    type ListCodexModelsResponse
} from '../codexModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerCodexModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListCodexModelsRequest, ListCodexModelsResponse>(RPC_METHODS.ListCodexModels, async (data) => {
        logger.debug('List Codex models request');
        const profiles = listCodexProfiles();
        const providers = listCodexProviders();

        try {
            const models = await listCodexModels(data?.includeHidden === true);
            return { success: true, models, profiles, providers };
        } catch (error) {
            logger.debug('Failed to list Codex models:', error);
            return {
                ...rpcError(getErrorMessage(error, 'Failed to list Codex models')),
                profiles,
                providers
            };
        }
    });
}
