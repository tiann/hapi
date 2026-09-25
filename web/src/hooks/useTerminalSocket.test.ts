import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// A minimal fake socket.io-client that records emits and lets the test drive
// lifecycle events (connect, connect_error, disconnect). The hook calls
// `new Manager(url, opts)` then `manager.socket('/terminal', { auth })`.
class FakeSocket {
    connected = false
    auth: unknown
    readonly emitted: Array<{ event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (arg?: unknown) => void>()

    constructor(auth: unknown, private readonly autoConnect: boolean) {
        this.auth = auth
    }

    on(event: string, handler: (arg?: unknown) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(event: string, data: unknown): boolean {
        this.emitted.push({ event, data })
        return true
    }

    connect(): void {
        this.connected = true
        if (this.autoConnect) {
            this.handlers.get('connect')?.()
        }
    }

    disconnect(): void {
        this.connected = false
    }

    removeAllListeners(): void {
        this.handlers.clear()
    }

    fireConnect(): void {
        this.connected = true
        this.handlers.get('connect')?.()
    }

    fireConnectError(message: string): void {
        this.handlers.get('connect_error')?.(new Error(message))
    }

    fireDisconnect(reason: string): void {
        this.connected = false
        this.handlers.get('disconnect')?.(reason)
    }
}

let lastSocket: FakeSocket | null = null

// Lets a test start from a rejected handshake (connect_error instead of connect).
const testState = vi.hoisted(() => ({ autoConnect: true }))

vi.mock('socket.io-client', () => ({
    Manager: class {
        socket(_nsp: string, opts: { auth: unknown }): FakeSocket {
            lastSocket = new FakeSocket(opts.auth, testState.autoConnect)
            return lastSocket
        }
    }
}))

import { useTerminalSocket } from './useTerminalSocket'

const options = { baseUrl: 'http://localhost:3000', token: 'tok', sessionId: 'session-1', terminalId: 'term-1' }

describe('useTerminalSocket error reporting', () => {
    beforeEach(() => {
        lastSocket = null
        testState.autoConnect = true
    })

    it('keeps the real connect error when the transport closes right after', () => {
        testState.autoConnect = false
        const { result } = renderHook(() => useTerminalSocket(options))

        act(() => result.current.connect(80, 24))
        act(() => lastSocket!.fireConnectError('xhr post error'))
        expect(result.current.state).toEqual({ status: 'error', error: 'xhr post error' })

        act(() => lastSocket!.fireDisconnect('transport error'))
        expect(result.current.state).toEqual({ status: 'error', error: 'xhr post error' })
    })

    it('reports a transport error for a connection that had been established', () => {
        const { result } = renderHook(() => useTerminalSocket(options))

        act(() => result.current.connect(80, 24))
        act(() => lastSocket!.fireDisconnect('transport error'))

        expect(result.current.state).toEqual({ status: 'error', error: 'Disconnected: transport error' })
    })

    it('clears the remembered connect error after a successful connect', () => {
        testState.autoConnect = false
        const { result } = renderHook(() => useTerminalSocket(options))

        act(() => result.current.connect(80, 24))
        act(() => lastSocket!.fireConnectError('xhr post error'))
        act(() => lastSocket!.fireConnect())
        act(() => lastSocket!.fireDisconnect('transport error'))

        expect(result.current.state).toEqual({ status: 'error', error: 'Disconnected: transport error' })
    })
})
