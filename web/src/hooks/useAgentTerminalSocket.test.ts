import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// A minimal fake socket.io-client that records emits and lets the test drive
// lifecycle events ('connect', etc.). The hook calls `new Manager(url, opts)`
// then `manager.socket('/terminal', { auth })`.
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

    subscribeCount(): number {
        return this.emitted.filter((e) => e.event === 'agent-terminal:subscribe').length
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

import { useAgentTerminalSocket } from './useAgentTerminalSocket'

const options = { baseUrl: 'http://localhost:3000', token: 'tok', sessionId: 'session-1' }

describe('useAgentTerminalSocket subscribe gating', () => {
    beforeEach(() => {
        lastSocket = null
        testState.autoConnect = true
    })

    it('does NOT subscribe on connect when the viewer never asked (hidden mount)', () => {
        const { result } = renderHook(() => useAgentTerminalSocket(options))

        act(() => result.current.connect())
        // connect() created the socket and connected it synchronously.
        expect(lastSocket).not.toBeNull()
        expect(lastSocket!.subscribeCount()).toBe(0)
    })

    it('subscribes only after resubscribe(), and re-subscribes across reconnects', () => {
        const { result } = renderHook(() => useAgentTerminalSocket(options))

        act(() => result.current.connect())
        expect(lastSocket!.subscribeCount()).toBe(0)

        // Becoming visible → resubscribe() emits the subscribe.
        act(() => result.current.resubscribe())
        expect(lastSocket!.subscribeCount()).toBe(1)

        // A reconnect (e.g. network blip) must re-emit subscribe because the
        // viewer is still watching.
        act(() => lastSocket!.connect())
        expect(lastSocket!.subscribeCount()).toBe(2)
    })

    it('does not subscribe when connect() is called again on an already-connected socket', () => {
        const { result } = renderHook(() => useAgentTerminalSocket(options))

        act(() => result.current.connect())
        // Second connect() hits the reuse branch (socket already exists +
        // connected); it must not subscribe on its own — only resubscribe() does.
        act(() => result.current.connect())
        expect(lastSocket!.subscribeCount()).toBe(0)
    })

    it('stops re-subscribing on reconnect after unsubscribe() (viewer left)', () => {
        const { result } = renderHook(() => useAgentTerminalSocket(options))

        act(() => result.current.connect())
        act(() => result.current.resubscribe())
        expect(lastSocket!.subscribeCount()).toBe(1)

        act(() => result.current.unsubscribe())
        // After leaving, a reconnect must NOT re-subscribe.
        act(() => lastSocket!.connect())
        expect(lastSocket!.subscribeCount()).toBe(1)
        expect(
            lastSocket!.emitted.some((e) => e.event === 'agent-terminal:unsubscribe')
        ).toBe(true)
    })
})

describe('useAgentTerminalSocket error reporting', () => {
    beforeEach(() => {
        lastSocket = null
        testState.autoConnect = true
    })

    it('keeps the real connect error when the transport closes right after', () => {
        testState.autoConnect = false
        const { result } = renderHook(() => useAgentTerminalSocket(options))

        act(() => result.current.connect())
        act(() => lastSocket!.fireConnectError('xhr post error'))
        expect(result.current.state).toEqual({ status: 'error', error: 'xhr post error' })

        act(() => lastSocket!.fireDisconnect('transport error'))
        expect(result.current.state).toEqual({ status: 'error', error: 'xhr post error' })
    })

    it('reports a transport error once a later connect succeeded', () => {
        testState.autoConnect = false
        const { result } = renderHook(() => useAgentTerminalSocket(options))

        act(() => result.current.connect())
        act(() => lastSocket!.fireConnectError('xhr post error'))
        act(() => lastSocket!.fireConnect())
        act(() => lastSocket!.fireDisconnect('transport error'))

        expect(result.current.state).toEqual({ status: 'error', error: 'Disconnected: transport error' })
    })
})
