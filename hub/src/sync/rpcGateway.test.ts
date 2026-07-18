import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { RpcGateway } from './rpcGateway'

describe('RpcGateway', () => {
    function gatewayWithResponse(response: () => Promise<unknown>): RpcGateway {
        const socket = {
            timeout: () => ({ emitWithAck: response })
        }
        const io = {
            of: () => ({ sockets: new Map([['socket-1', socket]]) })
        } as unknown as Server
        const registry = {
            getSocketIdForMethod: () => 'socket-1'
        } as unknown as RpcRegistry
        return new RpcGateway(io, registry)
    }

    it('rejects abort when the CLI RPC handler returns an encoded error', async () => {
        const socket = {
            timeout: () => ({
                emitWithAck: async () => JSON.stringify({ error: 'failed to durably canceled queued messages' })
            })
        }
        const io = {
            of: () => ({ sockets: new Map([['socket-1', socket]]) })
        } as unknown as Server
        const registry = {
            getSocketIdForMethod: () => 'socket-1'
        } as unknown as RpcRegistry

        const gateway = new RpcGateway(io, registry)

        await expect(gateway.abortSession('session-1')).rejects.toThrow('failed to durably canceled queued messages')
    })

    it('rejects a contradictory approve decision before issuing permission RPC', async () => {
        let rpcCalls = 0
        const gateway = gatewayWithResponse(async () => {
            rpcCalls += 1
            return null
        })
        const approvePermission = gateway.approvePermission.bind(gateway) as (
            sessionId: string,
            requestId: string,
            mode: undefined,
            allowTools: undefined,
            decision: string,
        ) => Promise<void>

        await expect(approvePermission('session-1', 'request-1', undefined, undefined, 'denied'))
            .rejects.toThrow(/contradictory.*approve/i)
        expect(rpcCalls).toBe(0)
    })

    it('rejects a contradictory deny decision before issuing permission RPC', async () => {
        let rpcCalls = 0
        const gateway = gatewayWithResponse(async () => {
            rpcCalls += 1
            return null
        })
        const denyPermission = gateway.denyPermission.bind(gateway) as (
            sessionId: string,
            requestId: string,
            decision: string,
        ) => Promise<void>

        await expect(denyPermission('session-1', 'request-1', 'approved'))
            .rejects.toThrow(/contradictory.*deny/i)
        expect(rpcCalls).toBe(0)
    })

    it('keeps the original spawn request pending when the acknowledgement is lost', async () => {
        const gateway = gatewayWithResponse(async () => {
            throw new Error('operation timed out after the Runner may have accepted it')
        })

        await expect(gateway.spawnSession(
            'machine-1',
            '/tmp/project',
            'codex',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            '11111111-1111-4111-8111-111111111111'
        )).resolves.toEqual({
            type: 'pending',
            spawnRequestId: '11111111-1111-4111-8111-111111111111'
        })
    })

    it('keeps an ambiguous query pending under the same request ID', async () => {
        const gateway = gatewayWithResponse(async () => JSON.stringify({ error: 'spawn store read failed' }))

        await expect(gateway.querySpawnSession(
            'machine-1',
            '22222222-2222-4222-8222-222222222222'
        )).resolves.toEqual({
            type: 'pending',
            spawnRequestId: '22222222-2222-4222-8222-222222222222'
        })
    })

    it('preserves an authoritative Runner not-found query result', async () => {
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'not_found',
            spawnRequestId: '22222222-2222-4222-8222-222222222222'
        }))

        await expect(gateway.querySpawnSession(
            'machine-1',
            '22222222-2222-4222-8222-222222222222'
        )).resolves.toEqual({
            type: 'not_found',
            spawnRequestId: '22222222-2222-4222-8222-222222222222'
        })
    })

    it('preserves a typed Runner operation-identity conflict', async () => {
        const spawnRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'conflict',
            spawnRequestId
        }))

        await expect(gateway.querySpawnSession('machine-1', spawnRequestId)).resolves.toEqual({
            type: 'conflict',
            spawnRequestId,
            message: `Spawn request '${spawnRequestId}' conflicts with its persisted operation identity`
        })
    })

    it('recognizes the exact legacy Runner conflict without broad string matching', async () => {
        const spawnRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'error',
            errorMessage: `spawnRequestId '${spawnRequestId}' was already used with different parameters`
        }))

        await expect(gateway.querySpawnSession('machine-1', spawnRequestId)).resolves.toEqual({
            type: 'conflict',
            spawnRequestId,
            message: `Spawn request '${spawnRequestId}' conflicts with its persisted operation identity`
        })
    })

    it('keeps a mismatched typed conflict pending instead of inventing a terminal fact', async () => {
        const spawnRequestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'conflict',
            spawnRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        }))

        await expect(gateway.querySpawnSession('machine-1', spawnRequestId)).resolves.toEqual({
            type: 'pending',
            spawnRequestId
        })
    })

    it('ignores a mismatched pending request ID from the Runner', async () => {
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'pending',
            spawnRequestId: '99999999-9999-4999-8999-999999999999'
        }))

        await expect(gateway.querySpawnSession(
            'machine-1',
            '22222222-2222-4222-8222-222222222222'
        )).resolves.toEqual({
            type: 'pending',
            spawnRequestId: '22222222-2222-4222-8222-222222222222'
        })
    })

    it('ignores an invalid pending request ID from the Runner', async () => {
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'pending',
            spawnRequestId: 'not-a-request-id'
        }))

        await expect(gateway.querySpawnSession(
            'machine-1',
            '22222222-2222-4222-8222-222222222222'
        )).resolves.toEqual({
            type: 'pending',
            spawnRequestId: '22222222-2222-4222-8222-222222222222'
        })
    })

    it('preserves an explicit Runner terminal spawn error', async () => {
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'error',
            errorMessage: 'child process group was proven empty'
        }))

        await expect(gateway.querySpawnSession(
            'machine-1',
            '33333333-3333-4333-8333-333333333333'
        )).resolves.toEqual({
            type: 'error',
            message: 'child process group was proven empty'
        })
    })

    it('preserves structured provider readiness details from the Runner', async () => {
        const gateway = gatewayWithResponse(async () => JSON.stringify({
            type: 'error',
            errorMessage: 'grok is not authenticated on this machine.',
            code: 'provider-not-authenticated',
            recoveryCommand: 'grok login --device-code'
        }))

        await expect(gateway.querySpawnSession(
            'machine-1',
            '44444444-4444-4444-8444-444444444444'
        )).resolves.toEqual({
            type: 'error',
            message: 'grok is not authenticated on this machine.',
            code: 'provider-not-authenticated',
            recoveryCommand: 'grok login --device-code'
        })
    })
})
