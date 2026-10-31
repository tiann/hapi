import { z } from 'zod'
import type { RpcRegistry } from '../../rpcRegistry'
import type { CliSocketWithData } from '../../socketTypes'

const rpcRegisterSchema = z.object({
    method: z.string().min(1)
})

const rpcUnregisterSchema = z.object({
    method: z.string().min(1)
})

export function registerRpcHandlers(socket: CliSocketWithData, rpcRegistry: RpcRegistry): void {
    socket.on('rpc-register', (data: unknown, callback?: (result: { ok: boolean }) => void) => {
        const parsed = rpcRegisterSchema.safeParse(data)
        if (!parsed.success) {
            callback?.({ ok: false })
            return
        }
        rpcRegistry.register(socket, parsed.data.method)
        callback?.({ ok: true })
    })

    socket.on('rpc-unregister', (data: unknown) => {
        const parsed = rpcUnregisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        rpcRegistry.unregister(socket, parsed.data.method)
    })
}
