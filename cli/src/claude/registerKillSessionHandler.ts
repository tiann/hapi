import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}

/**
 * tiann/hapi#914: callers can pass either a bare `cleanupAndExit` closure
 * (legacy) or an options object that lets the kill-RPC stamp an explicit
 * `archiveReason` before the lifecycle teardown runs. The hub only sends
 * KillSession when the operator clicked Archive in the UI, so this RPC is
 * the authoritative "user-terminated" signal; out-of-band SIGTERM from a
 * hub-restart cascade no longer collides with the default archive reason.
 */
export interface KillSessionLifecycle {
    cleanupAndExit: () => Promise<void>;
    setArchiveReason?: (reason: string) => void;
}

export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    lifecycleOrCleanup: KillSessionLifecycle | (() => Promise<void>)
) {
    const lifecycle: KillSessionLifecycle = typeof lifecycleOrCleanup === 'function'
        ? { cleanupAndExit: lifecycleOrCleanup }
        : lifecycleOrCleanup;

    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>(RPC_METHODS.KillSession, async () => {
        logger.debug('Kill session request received');

        // tiann/hapi#914: stamp the archive reason from the RPC path so the
        // default in `runnerLifecycle.ts` can be reassigned away from
        // 'User terminated'. A hub-restart-cascade SIGTERM does NOT go
        // through this handler — it hits the SIGTERM signal handler — so
        // those archives now stay labelled `'Hub restart'` (the new default).
        lifecycle.setArchiveReason?.('User terminated');

        // This will start the cleanup process
        void lifecycle.cleanupAndExit();

        // We should still be able to respond to the client, though they
        // should optimistically assume the session is dead.
        return {
            success: true,
            message: 'Killing hapi CLI process'
        };
    });
}
