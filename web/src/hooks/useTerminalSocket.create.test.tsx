import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalSocket } from './useTerminalSocket'

const testState = vi.hoisted(() => ({
    emissions: [] as Array<{ event: string; payload: unknown }>,
}))

vi.mock('socket.io-client', () => {
    type Handler = (...args: any[]) => void

    class FakeSocket {
        auth: Record<string, unknown> = {}
        connected = false
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
            this.connected = true
            this.fire('connect')
            return this
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
            return new FakeSocket()
        }
    }

    return { Manager }
})

describe('useTerminalSocket terminal creation', () => {
    beforeEach(() => {
        testState.emissions.length = 0
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
})