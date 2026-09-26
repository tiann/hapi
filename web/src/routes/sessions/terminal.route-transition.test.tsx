import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import TerminalPage from './terminal'

const testState = vi.hoisted(() => ({
    sessionId: 'session-a',
    emissions: [] as Array<{ event: string; payload: unknown }>,
    sockets: [] as Array<{ connected: boolean }>,
}))

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: testState.sessionId }),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: null,
        token: 'test-token',
        baseUrl: 'http://localhost:3000',
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => vi.fn() }))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: (_api: unknown, sessionId: string) => ({
        // Both sessions are returned synchronously to model an already-cached
        // active destination session. No active/support dependency changes are
        // available to accidentally bootstrap the new terminal socket.
        session: {
            id: sessionId,
            active: true,
            metadata: { path: `/tmp/${sessionId}` },
        },
    }),
}))

vi.mock('@/utils/terminalSupport', () => ({ isRemoteTerminalSupported: () => true }))

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: () => <div data-testid="terminal-view" />,
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

        emit(event: string, payload?: any) {
            testState.emissions.push({ event, payload })
            if (event === 'terminal:list') {
                queueMicrotask(() => {
                    this.fire('terminal:sessions', {
                        sessionId: payload.sessionId,
                        maxTerminals: 4,
                        terminals: [
                            {
                                terminalId: `terminal-${payload.sessionId}`,
                                createdAt: 1,
                                attached: false,
                            },
                        ],
                    })
                })
            }
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
            if (onceHandlers) {
                this.onceListeners.delete(event)
                for (const handler of onceHandlers) {
                    handler(...args)
                }
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

function page() {
    return (
        <I18nProvider>
            <TerminalPage />
        </I18nProvider>
    )
}

describe('TerminalPage session route transitions', () => {
    beforeEach(() => {
        testState.sessionId = 'session-a'
        testState.emissions.length = 0
        testState.sockets.length = 0
        window.localStorage.clear()
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            configurable: true,
            value: vi.fn().mockReturnValue({
                matches: false,
                media: '',
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(() => false),
            }),
        })
    })

    it('bootstraps terminal:list for a cached active destination session after A -> B', async () => {
        const view = render(page())

        await waitFor(() => {
            expect(
                testState.emissions.some(
                    ({ event, payload }) =>
                        event === 'terminal:list' &&
                        (payload as { sessionId?: string })?.sessionId === 'session-a'
                )
            ).toBe(true)
            expect(screen.getByText('/tmp/session-a')).toBeInTheDocument()
        })

        testState.emissions.length = 0
        const firstSocket = testState.sockets[0]

        testState.sessionId = 'session-b'
        view.rerender(page())

        await waitFor(() => {
            expect(
                testState.emissions.some(
                    ({ event, payload }) =>
                        event === 'terminal:list' &&
                        (payload as { sessionId?: string })?.sessionId === 'session-b'
                )
            ).toBe(true)
            expect(screen.getByText('/tmp/session-b')).toBeInTheDocument()
        })

        expect(firstSocket?.connected).toBe(false)
        expect(testState.sockets.length).toBeGreaterThanOrEqual(2)
    })
})
