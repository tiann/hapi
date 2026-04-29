import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listCodexSessions,
    type ListCodexSessionsRequest,
    type ListCodexSessionsResponse
} from '../codexSessions';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerCodexSessionHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListCodexSessionsRequest, ListCodexSessionsResponse>('listCodexSessions', async (data) => {
        logger.debug('List Codex sessions request');

        try {
            const result = await listCodexSessions(data ?? {});
            return {
                success: true,
                sessions: result.sessions,
                nextCursor: result.nextCursor
            };
        } catch (error) {
            logger.debug('Failed to list Codex sessions:', error);
            return rpcError(getErrorMessage(error, 'Failed to list Codex sessions'));
        }
    });
}
