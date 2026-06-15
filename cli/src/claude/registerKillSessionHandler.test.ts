import { describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { registerKillSessionHandler } from './registerKillSessionHandler'

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

        const result = await handler?.()
        expect(result).toEqual({ success: true, message: 'Killing hapi CLI process' })

        // setArchiveReason MUST be called BEFORE cleanupAndExit so the archive
        // metadata write reads the correct reason.
        const setReasonOrder = lifecycle.setArchiveReason.mock.invocationCallOrder[0]
        const cleanupOrder = lifecycle.cleanupAndExit.mock.invocationCallOrder[0]
        expect(setReasonOrder).toBeLessThan(cleanupOrder)
        expect(lifecycle.setArchiveReason).toHaveBeenCalledWith('User terminated')
        expect(lifecycle.cleanupAndExit).toHaveBeenCalled()
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
})
