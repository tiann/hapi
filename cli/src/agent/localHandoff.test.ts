import { describe, expect, it, vi } from 'vitest'
import { registerLocalHandoffHandler } from './localHandoff'

describe('registerLocalHandoffHandler', () => {
    it('registers handoff-local and schedules clean exit', async () => {
        const handlers = new Map<string, (params?: unknown) => unknown>()
        const rpcHandlerManager: Parameters<typeof registerLocalHandoffHandler>[0] = {
            registerHandler: (method, handler) => {
                handlers.set(method, handler as (params?: unknown) => unknown)
            }
        }
        const lifecycle = {
            setArchiveReason: vi.fn(),
            setSessionEndReason: vi.fn(),
            cleanupAndExit: vi.fn(async () => {})
        }

        registerLocalHandoffHandler(rpcHandlerManager, lifecycle)
        const handler = handlers.get('handoff-local')

        expect(handler).toBeDefined()
        expect(await handler?.()).toEqual({ ok: true })
        await new Promise((resolve) => setImmediate(resolve))

        expect(lifecycle.setArchiveReason).toHaveBeenCalledWith('Handed off to local terminal')
        expect(lifecycle.setSessionEndReason).toHaveBeenCalledWith('handoff')
        expect(lifecycle.cleanupAndExit).toHaveBeenCalledWith(0)
    })
})
