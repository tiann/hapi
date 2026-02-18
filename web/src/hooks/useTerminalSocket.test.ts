import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalSocket } from './useTerminalSocket'

class MockSocket {
    connected = false
    auth: Record<string, unknown> = {}
    private readonly handlers = new Map<string, Array<(...args: any[]) => void>>()

    readonly emit = vi.fn()
    readonly connect = vi.fn(() => {
        this.connected = true
    })
    readonly disconnect = vi.fn(() => {
        this.connected = false
        this.trigger('disconnect', 'io client disconnect')
    })
    readonly removeAllListeners = vi.fn(() => {
        this.handlers.clear()
    })

    on(event: string, handler: (...args: any[]) => void): this {
        const list = this.handlers.get(event) ?? []
        list.push(handler)
        this.handlers.set(event, list)
        return this
    }

    trigger(event: string, ...args: any[]): void {
        const list = this.handlers.get(event) ?? []
        for (const handler of list) {
            handler(...args)
        }
    }
}

const sockets: MockSocket[] = []

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => {
        const socket = new MockSocket()
        sockets.push(socket)
        return socket
    })
}))

describe('useTerminalSocket', () => {
    beforeEach(() => {
        sockets.length = 0
        vi.clearAllMocks()
    })

    it('transitions connecting -> connected', () => {
        const { result } = renderHook(() => useTerminalSocket({
            token: 'token',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            baseUrl: 'http://localhost:3000'
        }))

        act(() => {
            result.current.connect(80, 24)
        })

        expect(result.current.state.status).toBe('connecting')
        const socket = sockets[0]
        expect(socket.connect).toHaveBeenCalled()

        act(() => {
            socket.trigger('connect')
        })

        expect(result.current.state.status).toBe('connecting')
        expect(socket.emit).toHaveBeenCalledWith('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24
        })

        act(() => {
            socket.trigger('terminal:ready', { terminalId: 'terminal-1' })
        })

        expect(result.current.state.status).toBe('connected')
    })

    it('uses reconnecting for transient disconnects and recovers', () => {
        const { result } = renderHook(() => useTerminalSocket({
            token: 'token',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            baseUrl: 'http://localhost:3000'
        }))

        act(() => {
            result.current.connect(80, 24)
        })

        const socket = sockets[0]
        act(() => {
            socket.trigger('connect')
            socket.trigger('terminal:ready', { terminalId: 'terminal-1' })
        })
        expect(result.current.state.status).toBe('connected')

        act(() => {
            socket.trigger('disconnect', 'transport close')
        })
        expect(result.current.state.status).toBe('reconnecting')

        act(() => {
            socket.trigger('connect')
            socket.trigger('terminal:ready', { terminalId: 'terminal-1' })
        })
        expect(result.current.state.status).toBe('connected')
    })

    it('escalates repeated connect errors into terminal error', () => {
        const { result } = renderHook(() => useTerminalSocket({
            token: 'token',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            baseUrl: 'http://localhost:3000'
        }))

        act(() => {
            result.current.connect(80, 24)
        })

        const socket = sockets[0]
        act(() => {
            socket.trigger('connect_error', new Error('boom-1'))
        })
        expect(result.current.state.status).toBe('reconnecting')

        act(() => {
            socket.trigger('connect_error', new Error('boom-2'))
            socket.trigger('connect_error', new Error('boom-3'))
            socket.trigger('connect_error', new Error('boom-4'))
            socket.trigger('connect_error', new Error('boom-5'))
        })

        expect(result.current.state).toEqual({
            status: 'error',
            error: 'boom-5'
        })
    })
})
