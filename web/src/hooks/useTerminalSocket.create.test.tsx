import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalSocket } from './useTerminalSocket'

const testState = vi.hoisted(() => ({
    emissions: [] as Array<{ event: string; payload: unknown }>,
    sockets: [] as any[],
    deferConnect: false,
}))

vi.mock('socket.io-client', () => {
    type Handler = (...args: any[]) => void

    class FakeSocket {
        auth: Record<string, unknown> = {}
        connected = false
        connectRequested = false
        private listeners = new Map<string, Set<Handler>>()
        private onceListeners = new Map<string, Set<Handler>>()

        on(event: string, handler: Handler) {
            const handlers = this.listeners.get(event) ?? new Set<Handler>()
            handlers.add(handler)
            this.listeners.set(event, handlers)
            return this
        }

        once(event: string, handler: Handler) {
            const handlers = this.onceListeners.get(event) ?? new Set<Handler>()
            handlers.add(handler)
            this.onceListeners.set(event, handlers)
            return this
        }

        emit(event: string, payload?: unknown) {
            testState.emissions.push({ event, payload })
            return this
        }

        connect() {
            if (this.connected) return this
            this.connectRequested = true
            if (!testState.deferConnect) {
                this.finishConnect()
            }
            return this
        }

        finishConnect() {
            if (this.connected) return this
            this.connected = true
            this.connectRequested = false
            this.fire('connect')
            return this
        }

        serverEmit(event: string, payload: unknown) {
            this.fire(event, payload)
        }

        disconnect() {
            if (!this.connected) return this
            this.connected = false
            this.fire('disconnect', 'io client disconnect')
            return this
        }

        removeAllListeners() {
            this.listeners.clear()
            this.onceListeners.clear()
            return this
        }

        private fire(event: string, ...args: any[]) {
            for (const handler of this.listeners.get(event) ?? []) {
                handler(...args)
            }
            const onceHandlers = this.onceListeners.get(event)
            if (!onceHandlers) return
            this.onceListeners.delete(event)
            for (const handler of onceHandlers) {
                handler(...args)
            }
        }
    }

    class Manager {
        socket() {
            const socket = new FakeSocket()
            testState.sockets.push(socket)
            return socket
        }
    }

    return { Manager }
})

describe('useTerminalSocket terminal creation', () => {
    beforeEach(() => {
        testState.emissions.length = 0
        testState.sockets.length = 0
        testState.deferConnect = false
    })

    it('creates the PTY resource detached so the first explicit attach can replay startup output', async () => {
        const { result } = renderHook(() => useTerminalSocket({
            token: 'test-token',
            sessionId: 'session-1',
            terminalId: null,
            baseUrl: 'http://localhost:3000',
        }))

        act(() => {
            result.current.createTerminal('terminal-1', 80, 24)
        })

        await waitFor(() => {
            expect(testState.emissions).toContainEqual({
                event: 'terminal:create',
                payload: {
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                    cols: 80,
                    rows: 24,
                    attach: false,
                },
            })
        })
    })

    it('waits for authoritative inventory before attaching a detached create after reconnect', async () => {
        testState.deferConnect = true
        const { result } = renderHook(() => useTerminalSocket({
            token: 'test-token',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            baseUrl: 'http://localhost:3000',
        }))

        act(() => {
            result.current.createTerminal('terminal-1', 80, 24)
            // Model the newly-mounted xterm reporting its real size while the
            // transport is still reconnecting.
            result.current.connect(100, 30)
        })

        const socket = testState.sockets[0]
        expect(socket).toBeDefined()
        expect(socket.connectRequested).toBe(true)
        expect(testState.emissions.some(({ event }) => event === 'terminal:attach')).toBe(false)

        act(() => {
            socket.finishConnect()
        })

        await waitFor(() => {
            expect(testState.emissions.some(({ event }) => event === 'terminal:create')).toBe(true)
        })
        expect(testState.emissions.some(({ event }) => event === 'terminal:attach')).toBe(false)

        act(() => {
            socket.serverEmit('terminal:sessions', {
                sessionId: 'session-1',
                maxTerminals: 4,
                terminals: [{
                    terminalId: 'terminal-1',
                    createdAt: 1,
                    attached: false,
                }],
            })
        })

        await waitFor(() => {
            expect(testState.emissions).toContainEqual({
                event: 'terminal:attach',
                payload: {
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                    cols: 100,
                    rows: 30,
                },
            })
        })

        const createIndex = testState.emissions.findIndex(({ event }) => event === 'terminal:create')
        const attachIndex = testState.emissions.findIndex(({ event }) => event === 'terminal:attach')
        expect(createIndex).toBeGreaterThanOrEqual(0)
        expect(attachIndex).toBeGreaterThan(createIndex)
    })
})
