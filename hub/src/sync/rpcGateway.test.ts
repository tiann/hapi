import { describe, expect, it } from 'bun:test'
import { RpcGateway } from './rpcGateway'
import { RpcRegistry } from '../socket/rpcRegistry'

describe('RpcGateway', () => {
    it('sends list-importable-sessions rpc requests', async () => {
        const registry = new RpcRegistry()
        const captured: Array<{ event: string; payload: { method: string; params: string } }> = []

        const socket = {
            id: 'socket-1',
            timeout: () => ({
                emitWithAck: async (event: string, payload: { method: string; params: string }) => {
                    captured.push({ event, payload })
                    return { sessions: [] }
                }
            })
        }

        registry.register(socket as never, 'machine-1:list-importable-sessions')

        const io = {
            of: () => ({
                sockets: new Map([['socket-1', socket]])
            })
        }

        const gateway = new RpcGateway(io as never, registry)

        await expect(gateway.listImportableSessions('machine-1', { agent: 'codex' })).resolves.toEqual({ sessions: [] })
        expect(captured).toEqual([
            {
                event: 'rpc-request',
                payload: {
                    method: 'machine-1:list-importable-sessions',
                    params: JSON.stringify({ agent: 'codex' })
                }
            }
        ])
    })
})
