import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

/**
 * Lightweight stand-in for ApiMachineClient.connectUntilReady retry semantics:
 * ignore connect_error, resolve on connect within timeout.
 */
function connectUntilReadySemantics(
    socket: EventEmitter,
    timeoutMs: number,
): Promise<'ready' | 'timeout'> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            socket.off('connect', onConnect)
            resolve('timeout')
        }, timeoutMs)
        const onConnect = (): void => {
            clearTimeout(timer)
            resolve('ready')
        }
        socket.once('connect', onConnect)
        // Intentionally do not reject on connect_error — Socket.IO retries.
    })
}

describe('connectUntilReady retry semantics', () => {
    it('resolves after a transient connect_error followed by connect', async () => {
        const socket = new EventEmitter()
        const pending = connectUntilReadySemantics(socket, 500)
        socket.emit('connect_error', new Error('temporary'))
        queueMicrotask(() => {
            socket.emit('connect')
        })
        await expect(pending).resolves.toBe('ready')
    })

    it('times out when connect never arrives (reconnect still pending)', async () => {
        const socket = new EventEmitter()
        const pending = connectUntilReadySemantics(socket, 50)
        socket.emit('connect_error', new Error('temporary'))
        await expect(pending).resolves.toBe('timeout')
    })
})
