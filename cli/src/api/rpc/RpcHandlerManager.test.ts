import { describe, expect, it } from 'vitest'
import { RpcHandlerManager } from './RpcHandlerManager'

describe('RpcHandlerManager cancellation', () => {
    it('aborts an in-flight request by request id', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session-1' })
        manager.registerHandler('long-operation', async (_data, signal) => {
            return await new Promise<{ cancelled: boolean }>((resolve) => {
                signal?.addEventListener('abort', () => resolve({ cancelled: true }), { once: true })
            })
        })

        const request = manager.handleRequest({
            method: 'session-1:long-operation',
            params: '{}',
            requestId: 'request-1',
        })

        expect(manager.cancelRequest('request-1')).toBe(true)
        await expect(request).resolves.toBe(JSON.stringify({ cancelled: true }))
        expect(manager.cancelRequest('request-1')).toBe(false)
    })

    it('aborts active requests when the socket disconnects', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session-1' })
        manager.registerHandler('long-operation', async (_data, signal) => {
            return await new Promise<{ cancelled: boolean }>((resolve) => {
                signal?.addEventListener('abort', () => resolve({ cancelled: true }), { once: true })
            })
        })

        const request = manager.handleRequest({
            method: 'session-1:long-operation',
            params: '{}',
            requestId: 'request-2',
        })

        manager.onSocketDisconnect()
        await expect(request).resolves.toBe(JSON.stringify({ cancelled: true }))
    })

    it('does not log expected abort errors', async () => {
        const logs: unknown[] = []
        const manager = new RpcHandlerManager({
            scopePrefix: 'session-1',
            logger: (...args) => logs.push(args),
        })
        manager.registerHandler('long-operation', async (_data, signal) => {
            return await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    const error = new Error('Request aborted')
                    error.name = 'AbortError'
                    reject(error)
                }, { once: true })
            })
        })

        const request = manager.handleRequest({
            method: 'session-1:long-operation',
            params: '{}',
            requestId: 'request-3',
        })

        expect(manager.cancelRequest('request-3')).toBe(true)
        await expect(request).resolves.toBe(JSON.stringify({ error: 'Request aborted' }))
        expect(logs).toEqual([])
    })
})
