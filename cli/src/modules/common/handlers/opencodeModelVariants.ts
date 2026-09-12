import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listOpencodeModelVariants,
    type ListOpencodeModelVariantsResponse
} from '../opencodeModelVariants';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerOpencodeModelVariantsHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<{ cwd?: string | null } | undefined, ListOpencodeModelVariantsResponse>(RPC_METHODS.ListOpencodeModelVariants, async (data) => {
        logger.debug('List OpenCode model variants request');

        try {
            return await listOpencodeModelVariants({ cwd: data?.cwd ?? null });
        } catch (error) {
            logger.debug('Failed to list OpenCode model variants:', error);
            return rpcError(getErrorMessage(error, 'Failed to list OpenCode model variants'));
        }
    });
}
