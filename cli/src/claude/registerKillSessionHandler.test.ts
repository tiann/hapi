import { describe, expect, it, vi } from 'vitest'
import { getSessionStopPreparationMethod, RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { registerKillSessionHandler } from './registerKillSessionHandler'
import { monotonicTimeMs } from '@/utils/time'

vi.mock('@/utils/time', async (original) => ({
    ...await original<typeof import('@/utils/time')>(), monotonicTimeMs: () => Date.now()
}))
vi.mock('@/utils/process', async (original) => ({
    ...await original<typeof import('@/utils/process')>(), getProcessStartMarker: () => 'generation'
}))

// tiann/hapi#914: the KillSession RPC is the authoritative "user-terminated"
// signal because the hub only sends it when the operator clicks Archive in
// the web UI. Out-of-band SIGTERM (hub-restart cascade, host-level `kill`)
// hits the SIGTERM signal handler in runnerLifecycle, which now keeps the
// default reason 'Hub restart' so the audit trail stays correct.
describe('registerKillSessionHandler (tiann/hapi#914)', () => {
    function makeRegistry() {
        const handlers = new Map<string, (params?: unknown) => unknown>()
        return {
            registerHandler: (method: string, handler: (params: unknown) => unknown) => {
                handlers.set(method, handler as (params?: unknown) => unknown)
            },
            handlers
        }
    }

    it('stamps archiveReason=User terminated before triggering cleanupAndExit', async () => {
        const registry = makeRegistry()
        const lifecycle = {
            setArchiveReason: vi.fn(),
            cleanupAndExit: vi.fn(async () => {})
        }

        registerKillSessionHandler(
            registry as unknown as Parameters<typeof registerKillSessionHandler>[0],
            lifecycle
        )

        const handler = registry.handlers.get(RPC_METHODS.KillSession)
        expect(handler).toBeDefined()

        const result = await handler?.() as { success: boolean; message: string; pid: number; processStartMarker?: string }
        expect(result.success).toBe(true)
        expect(result.message).toBe('Killing hapi CLI process')
        expect(result.pid).toBe(process.pid)
        expect(typeof result.processStartMarker === 'string' || result.processStartMarker === undefined).toBe(true)

        // setArchiveReason MUST be called BEFORE cleanupAndExit so the archive
        // metadata write reads the correct reason.
        const setReasonOrder = lifecycle.setArchiveReason.mock.invocationCallOrder[0]
        const cleanupOrder = lifecycle.cleanupAndExit.mock.invocationCallOrder[0]
        expect(setReasonOrder).toBeLessThan(cleanupOrder)
        expect(lifecycle.setArchiveReason).toHaveBeenCalledWith('User terminated')
        expect(lifecycle.cleanupAndExit).toHaveBeenCalled()
    })

    it('keeps the process alive after prepare-only ACK so the runner can collect and terminate its tree', async () => {
        const registry = makeRegistry()
        const beforeKill = vi.fn(async () => {})
        const cleanupAndExit = vi.fn(async () => {})
        registerKillSessionHandler(registry as never, { beforeKill, cleanupAndExit })
        const result = await registry.handlers.get(RPC_METHODS.KillSession)?.({ prepareOnly: true,
            preparationLease: { id: 'fixture', expiresAt: monotonicTimeMs() + 30000 } }) as { success: boolean }
        expect(result.success).toBe(true)
        expect(beforeKill).toHaveBeenCalledOnce()
        expect(cleanupAndExit).not.toHaveBeenCalled()
    })

    it('registers an immutable machine/PID preparation alias with generation validation', async () => {
        const registry = makeRegistry()
        const beforeKill = vi.fn(async () => true)
        const cleanupAndExit = vi.fn(async () => {})
        const lifecycle = { machineId: 'machine/one', beforeKill, cleanupAndExit }
        registerKillSessionHandler(registry as never, lifecycle)
        lifecycle.machineId = 'changed-metadata-machine'
        const handler = registry.handlers.get(getSessionStopPreparationMethod('machine/one', process.pid))!
        expect(handler).toBeDefined()
        const request = { prepareOnly: true, expectedMachineId: 'machine/one', expectedPid: process.pid,
            expectedProcessStartMarker: 'generation', preparationLease: { id: 'fixture', expiresAt: monotonicTimeMs() + 30000 } }
        const response = await handler(request) as { success: boolean; machineId: string; pid: number }
        expect(response).toMatchObject({ success: true, machineId: 'machine/one', pid: process.pid })
        expect(beforeKill).toHaveBeenCalledOnce()
        expect(cleanupAndExit).not.toHaveBeenCalled()
        await expect(handler({ ...request, expectedProcessStartMarker: 'other-generation' })).rejects.toThrow('generation')
        await expect(handler({ ...request, expectedMachineId: 'other-machine' })).rejects.toThrow('exact preparation target')
        await expect(handler({ ...request, prepareOnly: false })).rejects.toThrow('exact preparation target')
        expect(beforeKill).toHaveBeenCalledOnce()
    })

    it('rejects unconfirmed drains and mismatched process targets before cleanup', async () => {
        const registry = makeRegistry()
        const cleanupAndExit = vi.fn(async () => {})
        const beforeKill = vi.fn(async () => false)
        registerKillSessionHandler(registry as never, { beforeKill, cleanupAndExit })
        const handler = registry.handlers.get(RPC_METHODS.KillSession)!
        await expect(handler({ prepareOnly: true, expectedPid: process.pid + 1, expectedProcessStartMarker: 'other' })).rejects.toThrow('generation')
        expect(beforeKill).not.toHaveBeenCalled()
        await expect(handler({ prepareOnly: true, preparationLease: { id: 'fixture', expiresAt: monotonicTimeMs() + 30000 } })).rejects.toThrow('not confirmed')
        expect(cleanupAndExit).not.toHaveBeenCalled()
    })

    it('rejects locally without starting cleanup when the pre-kill drain rejects', async () => {
        const registry = makeRegistry()
        const cleanupAndExit = vi.fn(async () => {})
        registerKillSessionHandler(registry as never, {
            cleanupAndExit,
            beforeKill: async () => { throw new Error('drain unavailable') }
        })
        await expect(registry.handlers.get(RPC_METHODS.KillSession)?.()).rejects.toThrow('drain unavailable')
        expect(cleanupAndExit).not.toHaveBeenCalled()
    })

    it('still works with the legacy `(cleanupAndExit: () => Promise<void>)` call shape', async () => {
        // Back-compat: runAgentSession.ts passes a bare closure as the second
        // argument instead of a lifecycle object. The handler should not crash
        // when setArchiveReason is absent.
        const registry = makeRegistry()
        const cleanupAndExit = vi.fn(async () => {})

        registerKillSessionHandler(
            registry as unknown as Parameters<typeof registerKillSessionHandler>[0],
            cleanupAndExit
        )

        const handler = registry.handlers.get(RPC_METHODS.KillSession)
        await handler?.()

        expect(cleanupAndExit).toHaveBeenCalled()
    })

    it('exits on hub-archived metadata when a session listener is provided (#1910)', async () => {
        const registry = makeRegistry()
        const lifecycle = {
            setArchiveReason: vi.fn(),
            cleanupAndExit: vi.fn(async () => {})
        }
        const listeners = new Map<string, () => void>()
        const session = {
            on(event: string, listener: () => void) {
                listeners.set(event, listener)
            }
        }

        registerKillSessionHandler(
            registry as unknown as Parameters<typeof registerKillSessionHandler>[0],
            lifecycle,
            session
        )

        expect(listeners.has('hub-archived')).toBe(true)
        listeners.get('hub-archived')?.()
        expect(lifecycle.setArchiveReason).toHaveBeenCalledWith('User terminated')
        expect(lifecycle.cleanupAndExit).toHaveBeenCalled()
    })

    it('exits when registration happens after hub-archived write (production order, #1911 AC6)', async () => {
        // Production: bootstrap updateMetadata / ack may noteHubArchived before
        // flavor runners call registerKillSessionHandler. EventEmitter does not
        // replay — without the latch, cleanupAndExit stays 0×.
        const registry = makeRegistry()
        const lifecycle = {
            setArchiveReason: vi.fn(),
            cleanupAndExit: vi.fn(async () => {})
        }
        const listeners = new Map<string, () => void>()
        const session: {
            hubArchived: boolean
            on(event: string, listener: () => void): void
        } = {
            hubArchived: false,
            on(event: string, listener: () => void) {
                listeners.set(event, listener)
            }
        }

        // Write first (noteHubArchived), then register — production order.
        session.hubArchived = true
        // Emit with no listeners yet (would be missed without the latch).
        listeners.get('hub-archived')?.()

        registerKillSessionHandler(
            registry as unknown as Parameters<typeof registerKillSessionHandler>[0],
            lifecycle,
            session
        )

        expect(lifecycle.setArchiveReason).toHaveBeenCalledWith('User terminated')
        expect(lifecycle.cleanupAndExit).toHaveBeenCalledTimes(1)
        // Still subscribed for any later emit.
        expect(listeners.has('hub-archived')).toBe(true)
    })
})
