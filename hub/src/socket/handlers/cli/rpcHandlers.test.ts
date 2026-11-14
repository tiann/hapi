import { describe, expect, it, mock } from 'bun:test'
import { registerRpcHandlers } from './rpcHandlers'
import type { CliSocketWithData } from '../../socketTypes'
import type { RpcRegistry } from '../../rpcRegistry'

describe('RPC registration acknowledgement', () => {
    it('acknowledges only after registration and rejects malformed methods', () => {
        const handlers = new Map<string, (...args: any[]) => void>()
        const socket = { on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler) } as unknown as CliSocketWithData
        const order: string[] = []
        const register = mock(() => { order.push('registered') })
        registerRpcHandlers(socket, { register, unregister() {} } as unknown as RpcRegistry)
        handlers.get('rpc-register')!({ method: 'session:config' }, (result: { ok: boolean }) => {
            expect(result.ok).toBe(true);order.push('acknowledged')
        })
        expect(order).toEqual(['registered', 'acknowledged'])
        const rejected = mock()
        handlers.get('rpc-register')!({ method: '' }, rejected)
        expect(rejected).toHaveBeenCalledWith({ ok: false })
        expect(register).toHaveBeenCalledTimes(1)
        handlers.get('rpc-register')!({ method: 'session:legacy' })
        expect(register).toHaveBeenCalledTimes(2)
    })
})
