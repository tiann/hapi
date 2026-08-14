import { z } from 'zod'
import type { RpcRegistry } from '../../rpcRegistry'
import type { CliSocketWithData } from '../../socketTypes'

const rpcRegisterSchema = z.object({
    method: z.string().min(1)
})

const rpcUnregisterSchema = z.object({
    method: z.string().min(1)
})

export function registerRpcHandlers(
    socket: CliSocketWithData,
    rpcRegistry: RpcRegistry,
    canUseMethod: (method: string) => boolean = () => true
): void {
    socket.on('rpc-register', (data: unknown) => {
        const parsed = rpcRegisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        if (!canUseMethod(parsed.data.method)) return
        rpcRegistry.register(socket, parsed.data.method, () => canUseMethod(parsed.data.method))
    })

    socket.on('rpc-unregister', (data: unknown) => {
        const parsed = rpcUnregisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        if (!canUseMethod(parsed.data.method)) return
        rpcRegistry.unregister(socket, parsed.data.method)
    })
}
