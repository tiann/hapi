import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listOpencodeModelsForCwd,
    type ListOpencodeModelsForCwdRequest,
    type ListOpencodeModelsForCwdResponse
} from '../opencodeModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerOpencodeModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListOpencodeModelsForCwdRequest, ListOpencodeModelsForCwdResponse>(
        'listOpencodeModelsForCwd',
        async (data) => {
            logger.debug('List OpenCode models for cwd request', { cwd: data?.cwd });

            try {
                const cwd = typeof data?.cwd === 'string' ? data.cwd : '';
                return await listOpencodeModelsForCwd(cwd);
            } catch (error) {
                logger.debug('Failed to list OpenCode models:', error);
                return rpcError(getErrorMessage(error, 'Failed to list OpenCode models'));
            }
        }
    );
}
