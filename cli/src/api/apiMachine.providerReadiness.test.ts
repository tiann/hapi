import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_CAPABILITIES, type ProviderReadinessMap } from '@hapi/protocol'
import { buildMachineMetadata } from '@/agent/sessionFactory'
import { ApiMachineClient, MACHINE_UPDATE_ACK_TIMEOUT_MS } from './apiMachine'
import type { Machine } from './types'

const readiness: ProviderReadinessMap = {
    grok: {
        status: 'ready',
        installed: true,
        authenticated: true,
        authCheck: 'credential-file',
        version: '0.2.101',
        ...PROVIDER_CAPABILITIES.grok,
        checkedAt: 1_800_000_000_000,
    },
}

function existingMachine(): Machine {
    return {
        id: 'machine-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: buildMachineMetadata(),
        metadataVersion: 7,
        runnerState: null,
        runnerStateVersion: 0,
    }
}

describe('ApiMachineClient provider readiness publication', () => {
    it('writes the fresh snapshot through the existing versioned metadata channel', async () => {
        const machine = existingMachine()
        const emitWithAck = vi.fn(async (_event: string, payload: { metadata: unknown }) => ({
            result: 'success',
            version: 8,
            metadata: payload.metadata,
        }))
        const timeout = vi.fn(() => ({ emitWithAck }))
        const client = new ApiMachineClient('token', machine)
        ;(client as unknown as { socket: { timeout: typeof timeout } }).socket = { timeout }

        await client.updateMachineMetadataOnce(() => buildMachineMetadata(readiness))

        expect(timeout).toHaveBeenCalledWith(MACHINE_UPDATE_ACK_TIMEOUT_MS)
        expect(emitWithAck).toHaveBeenCalledOnce()
        const [, payload] = emitWithAck.mock.calls[0]!
        expect(payload).toMatchObject({
            machineId: 'machine-1',
            expectedVersion: 7,
        })
        expect(machine.metadataVersion).toBe(8)
        expect(machine.metadata?.providerReadiness?.grok?.status).toBe('ready')
    })

    it('preserves structured readiness errors across the machine RPC boundary', async () => {
        const client = new ApiMachineClient('token', existingMachine())
        client.setRPCHandlers({
            spawnSession: async () => ({
                type: 'error',
                errorMessage: 'grok is not authenticated on this machine.',
                code: 'provider-not-authenticated',
                recoveryCommand: 'grok login --device-code',
            } as never),
            querySpawnSession: async (spawnRequestId) => ({ type: 'pending', spawnRequestId }),
            stopSession: () => true,
            requestShutdown: () => undefined,
        })

        const response = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:spawn-happy-session',
            params: JSON.stringify({ directory: '/tmp/project', agent: 'grok' }),
        })

        expect(JSON.parse(response)).toEqual({
            type: 'error',
            errorMessage: 'grok is not authenticated on this machine.',
            code: 'provider-not-authenticated',
            recoveryCommand: 'grok login --device-code',
        })
    })

    it('passes expected spawn parameters into a parameter-aware request lookup', async () => {
        const client = new ApiMachineClient('token', existingMachine())
        let lookup: { spawnRequestId: string; directory?: string; agent?: string; model?: string } | null = null
        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            querySpawnSession: async (spawnRequestId, expectedOptions) => {
                lookup = {
                    spawnRequestId,
                    directory: expectedOptions?.directory,
                    agent: expectedOptions?.agent,
                    model: expectedOptions?.model,
                }
                return { type: 'not_found', spawnRequestId }
            },
            stopSession: () => true,
            requestShutdown: () => undefined,
        })

        const response = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:query-happy-session-spawn',
            params: JSON.stringify({
                spawnRequestId: '61616161-6161-4616-8616-616161616161',
                directory: '/tmp/project',
                agent: 'codex',
                model: 'gpt-5.6-sol'
            }),
        })

        expect(lookup as unknown).toEqual({
            spawnRequestId: '61616161-6161-4616-8616-616161616161',
            directory: '/tmp/project',
            agent: 'codex',
            model: 'gpt-5.6-sol'
        })
        expect(JSON.parse(response)).toEqual({
            type: 'not_found',
            spawnRequestId: '61616161-6161-4616-8616-616161616161'
        })
    })

    it('preserves a typed operation-identity conflict across the machine RPC boundary', async () => {
        const client = new ApiMachineClient('token', existingMachine())
        const spawnRequestId = '71717171-7171-4717-8717-717171717171'
        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            querySpawnSession: async () => ({ type: 'conflict', spawnRequestId }),
            stopSession: () => true,
            requestShutdown: () => undefined,
        })

        const response = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:query-happy-session-spawn',
            params: JSON.stringify({
                spawnRequestId,
                directory: '/tmp/project',
                agent: 'claude',
                resumeSessionId: 'claude-session-1'
            }),
        })

        expect(JSON.parse(response)).toEqual({ type: 'conflict', spawnRequestId })
    })

    it('bounds acknowledgement retries instead of stalling readiness maintenance forever', async () => {
        const machine = existingMachine()
        const emitWithAck = vi.fn(async () => {
            throw new Error('operation has timed out')
        })
        const timeout = vi.fn(() => ({ emitWithAck }))
        const client = new ApiMachineClient('token', machine)
        ;(client as unknown as { socket: { timeout: typeof timeout } }).socket = { timeout }

        await expect(client.updateMachineMetadata(() => buildMachineMetadata(readiness)))
            .rejects.toThrow('operation has timed out')
        expect(emitWithAck).toHaveBeenCalledTimes(3)
    })

    it('retries a version race without regressing a newer published readiness entry', async () => {
        const machine = existingMachine()
        const newerReadiness: ProviderReadinessMap = {
            grok: {
                ...readiness.grok!,
                checkedAt: readiness.grok!.checkedAt + 100,
            },
        }
        const newerMetadata = buildMachineMetadata(newerReadiness, machine.metadata)
        let calls = 0
        const emitWithAck = vi.fn(async (_event: string, payload: { metadata: unknown }) => {
            calls += 1
            return calls === 1
                ? { result: 'version-mismatch', version: 8, metadata: newerMetadata }
                : { result: 'success', version: 9, metadata: payload.metadata }
        })
        const timeout = vi.fn(() => ({ emitWithAck }))
        const client = new ApiMachineClient('token', machine)
        ;(client as unknown as { socket: { timeout: typeof timeout } }).socket = { timeout }

        await client.updateMachineMetadata((current) => buildMachineMetadata(readiness, current))

        expect(emitWithAck).toHaveBeenCalledTimes(2)
        expect(emitWithAck.mock.calls.map(([, payload]) => payload)).toEqual([
            expect.objectContaining({ expectedVersion: 7 }),
            expect.objectContaining({ expectedVersion: 8 }),
        ])
        expect(machine.metadataVersion).toBe(9)
        expect(machine.metadata?.providerReadiness?.grok?.checkedAt)
            .toBe(newerReadiness.grok!.checkedAt)
    })
})
