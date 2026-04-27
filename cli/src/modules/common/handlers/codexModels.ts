import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listCodexModels,
    type ListCodexModelsRequest,
    type ListCodexModelsResponse
} from '../codexModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerCodexModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListCodexModelsRequest, ListCodexModelsResponse>('listCodexModels', async (data) => {
        logger.debug('List Codex models request');

        try {
            const models = await listCodexModels(data?.includeHidden === true);
            return { success: true, models };
        } catch (error) {
            logger.debug('Failed to list Codex models:', error);
            return rpcError(getErrorMessage(error, 'Failed to list Codex models'));
        }
    });
}
