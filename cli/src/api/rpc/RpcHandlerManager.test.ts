import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import { RpcHandlerManager } from './RpcHandlerManager'

describe('RPC registration barrier', () => {
    it('waits for the first socket connection within the registration deadline', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger() {} })
        manager.registerHandler('config', async () => null)
        const result = manager.waitForRegistration('config', 1000).then(() => 'ready', error => error)
        await new Promise(resolve => setTimeout(resolve, 10))
        const emitWithAck = vi.fn(async () => ({ ok: true }))
        manager.onSocketConnect({ connected: true, emit() {}, timeout: () => ({ emitWithAck }) } as unknown as Socket)
        expect(await result).toBe('ready')
        expect(emitWithAck).toHaveBeenCalledOnce()
    })

    it('bounds the wait for a socket that never connects', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger() {} })
        manager.registerHandler('config', async () => null)
        await expect(manager.waitForRegistration('config', 10)).rejects.toThrow('Timed out')
    })

    it('retries on a replacement socket after a disconnect during acknowledgement', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger() {} })
        manager.registerHandler('config', async () => null)
        let reject!: (error: Error) => void
        const firstAck = new Promise((_, fail) => { reject = fail })
        manager.onSocketConnect({ connected: true, emit() {}, timeout: () => ({ emitWithAck: () => firstAck }) } as unknown as Socket)
        const result = manager.waitForRegistration('config', 1000).then(() => 'ready', error => error)
        await Promise.resolve()
        manager.onSocketDisconnect()
        reject(new Error('socket disconnected'))
        const emitWithAck = vi.fn(async () => ({ ok: true }))
        manager.onSocketConnect({ connected: true, emit() {}, timeout: () => ({ emitWithAck }) } as unknown as Socket)
        expect(await result).toBe('ready')
        expect(emitWithAck).toHaveBeenCalledOnce()
    })

    it('waits for the Hub acknowledgement of the scoped handler', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger() {} })
        let acknowledge!: (result: { ok: boolean }) => void
        const ack = new Promise(resolve => { acknowledge = resolve })
        const emitWithAck = vi.fn(() => ack)
        const socket = { connected: true, emit: vi.fn(), timeout: vi.fn(() => ({ emitWithAck })) } as unknown as Socket
        manager.registerHandler('config', async () => null)
        manager.onSocketConnect(socket)
        let ready = false
        const waiting = manager.waitForRegistration('config').then(() => { ready = true })
        await Promise.resolve()
        expect(ready).toBe(false)
        expect(emitWithAck).toHaveBeenCalledWith('rpc-register', { method: 'session:config' })
        acknowledge({ ok: true });await waiting
        expect(ready).toBe(true)
    })

    it('fails closed for a missing handler or a disconnected socket', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger() {} })
        await expect(manager.waitForRegistration('config')).rejects.toThrow('connected handler')
    })

    it('does not report a rejected registration as ready', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger() {} })
        manager.registerHandler('config', async () => null)
        manager.onSocketConnect({ connected: true, emit() {}, timeout: () => ({ emitWithAck: async () => ({ ok: false }) }) } as unknown as Socket)
        await expect(manager.waitForRegistration('config')).rejects.toThrow('Hub rejected')
    })
})
