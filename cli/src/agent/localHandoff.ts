import type { SessionEndReason } from '@hapi/protocol'

type RpcHandlerManagerLike = {
    registerHandler<TRequest = unknown, TResponse = unknown>(
        method: string,
        handler: (params: TRequest) => Promise<TResponse> | TResponse
    ): void
}

type LocalHandoffLifecycle = {
    setArchiveReason: (reason: string) => void
    setSessionEndReason: (reason: SessionEndReason) => void
    cleanupAndExit: (codeOverride?: number) => Promise<void>
}

export function registerLocalHandoffHandler(
    rpcHandlerManager: RpcHandlerManagerLike,
    lifecycle: LocalHandoffLifecycle
): void {
    rpcHandlerManager.registerHandler('handoff-local', () => {
        lifecycle.setArchiveReason('Handed off to local terminal')
        lifecycle.setSessionEndReason('handoff')
        setImmediate(() => {
            void lifecycle.cleanupAndExit(0)
        })
        return { ok: true }
    })
}
