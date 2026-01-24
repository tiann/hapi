import type { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager"
import { logger } from "@/lib"

interface ResumeSessionRequest {
    // No parameters needed
}

interface ResumeSessionResponse {
    success: boolean
    message: string
}

/**
 * Registers the resume session RPC handler.
 *
 * This handler is called when the server attempts to resume a session.
 * If this handler is invoked, it means the CLI process is still running
 * and just needs to be "woken up" - no new process spawn is needed.
 *
 * If the CLI process has exited, the RPC call will fail and the server
 * will spawn a new process with --resume instead.
 */
export function registerResumeSessionHandler(
    rpcHandlerManager: RpcHandlerManager
) {
    rpcHandlerManager.registerHandler<ResumeSessionRequest, ResumeSessionResponse>('resumeSession', async () => {
        logger.info('Resume requested - session is already active')

        return {
            success: true,
            message: 'Session is active'
        }
    })
}
