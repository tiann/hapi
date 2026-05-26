import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { RpcGateway } from './rpcGateway'

function createGateway(responder?: (payload: { method: string; params: string }) => unknown) {
    const timeouts: number[] = []
    const socket = {
        timeout(timeoutMs: number) {
            timeouts.push(timeoutMs)
            return {
                async emitWithAck(_event: string, payload: { method: string; params: string }) {
                    const value = responder
                        ? responder(payload)
                        : { success: true, method: payload.method, params: JSON.parse(payload.params) as unknown }
                    return JSON.stringify(value)
                }
            }
        }
    }

    const io = {
        of() {
            return {
                sockets: {
                    get() {
                        return socket
                    }
                }
            }
        }
    } as unknown as Server

    const rpcRegistry = {
        getSocketIdForMethod() {
            return 'socket-1'
        }
    } as unknown as RpcRegistry

    return {
        gateway: new RpcGateway(io, rpcRegistry),
        timeouts
    }
}

describe('RpcGateway RPC timeouts', () => {
    it('uses the default RPC timeout for regular machine RPCs', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listMachineDirectory('machine-1', 'C:\\workspace')

        expect(timeouts).toEqual([30_000])
    })

    it('uses an extended RPC timeout when listing Codex models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCodexModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })
})

describe('RpcGateway spawnSession', () => {
    it('forwards plugin agent ids to the machine-scoped spawn RPC', async () => {
        const seen: Array<{ method: string; params: unknown }> = []
        const { gateway } = createGateway((payload) => {
            seen.push({ method: payload.method, params: JSON.parse(payload.params) as unknown })
            return { type: 'success', sessionId: 'session-1' }
        })

        const result = await gateway.spawnSession('machine-1', '/repo', 'vendor:example-agent')

        expect(result).toEqual({ type: 'success', sessionId: 'session-1' })
        expect(seen).toEqual([
            {
                method: 'machine-1:spawn-happy-session',
                params: expect.objectContaining({
                    type: 'spawn-in-directory',
                    directory: '/repo',
                    agent: 'vendor:example-agent'
                })
            }
        ])
    })
})



describe('RpcGateway runner plugin RPC methods', () => {
    it('uses machine-scoped runner plugin method names', async () => {
        const seen: Array<{ method: string; params: unknown }> = []
        const { gateway } = createGateway((payload) => {
            seen.push({ method: payload.method, params: JSON.parse(payload.params) as unknown })
            return { machineId: 'machine-1', updatedAt: 1, plugins: [], diagnostics: [] }
        })

        const result = await gateway.listRunnerPlugins('machine-1')

        expect(result.machineId).toBe('machine-1')
        expect(seen).toEqual([{ method: 'machine-1:runner.plugins.list', params: {} }])
    })

    it('uses machine-scoped agent history import method names', async () => {
        const seen: Array<{ method: string; params: unknown }> = []
        const { gateway } = createGateway((payload) => {
            seen.push({ method: payload.method, params: JSON.parse(payload.params) as unknown })
            return { messages: [{ role: 'user', content: 'hello' }] }
        })

        const result = await gateway.importRunnerAgentHistory('machine-1', {
            agentId: 'vendor:example-agent',
            nativeSessionId: 'native-session-1'
        })

        expect(result).toEqual({ messages: [{ role: 'user', content: 'hello' }] })
        expect(seen).toEqual([{
            method: 'machine-1:runner.agent.history.import',
            params: { agentId: 'vendor:example-agent', nativeSessionId: 'native-session-1' }
        }])
    })
})
