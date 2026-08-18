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

    it('does not reattach a stale tab before a detached create is confirmed after reconnect', async () => {
        testState.deferConnect = true
        const hook = renderHook(
            ({ terminalId }: { terminalId: string }) => useTerminalSocket({
                token: 'test-token',
                sessionId: 'session-1',
                terminalId,
                baseUrl: 'http://localhost:3000',
            }),
            { initialProps: { terminalId: 'terminal-a' } }
        )

        // Establish A first so the hook has an existing socket and xterm size.
        act(() => {
            hook.result.current.connect(80, 24)
        })
        const socket = testState.sockets[0]
        act(() => {
            socket.finishConnect()
        })
        await waitFor(() => {
            expect(testState.emissions).toContainEqual({
                event: 'terminal:attach',
                payload: {
                    sessionId: 'session-1',
                    terminalId: 'terminal-a',
                    cols: 80,
                    rows: 24,
                },
            })
        })

        act(() => {
            socket.disconnect()
        })
        testState.emissions.length = 0

        // Manual New calls create(B) before React commits activeTerminalId=B.
        // Reconnect therefore sees stale terminalId=A unless pending-create
        // gating suppresses the generic reattach path.
        act(() => {
            hook.result.current.createTerminal('terminal-b', 80, 24)
        })
        expect(socket.connectRequested).toBe(true)

        act(() => {
            socket.finishConnect()
        })

        await waitFor(() => {
            expect(testState.emissions.some(({ event }) => event === 'terminal:create')).toBe(true)
        })
        expect(
            testState.emissions.some(
                ({ event, payload }) => event === 'terminal:attach'
                    && (payload as { terminalId?: string })?.terminalId === 'terminal-a'
            )
        ).toBe(false)
        expect(testState.emissions.some(({ event }) => event === 'terminal:attach')).toBe(false)

        hook.rerender({ terminalId: 'terminal-b' })
        act(() => {
            // Model B's newly-mounted xterm reporting its own dimensions.
            hook.result.current.connect(100, 30)
        })
        expect(testState.emissions.some(({ event }) => event === 'terminal:attach')).toBe(false)

        act(() => {
            socket.serverEmit('terminal:sessions', {
                sessionId: 'session-1',
                maxTerminals: 4,
                terminals: [{
                    terminalId: 'terminal-b',
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
                    terminalId: 'terminal-b',
                    cols: 100,
                    rows: 30,
                },
            })
        })

        const createIndex = testState.emissions.findIndex(({ event }) => event === 'terminal:create')
        const attachIndex = testState.emissions.findIndex(
            ({ event, payload }) => event === 'terminal:attach'
                && (payload as { terminalId?: string })?.terminalId === 'terminal-b'
        )
        expect(createIndex).toBeGreaterThanOrEqual(0)
        expect(attachIndex).toBeGreaterThan(createIndex)
    })
})
