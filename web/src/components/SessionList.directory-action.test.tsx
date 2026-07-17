import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => cleanup())

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        }
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>
                    {children}
                    <ToastProbe />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

function ToastProbe() {
    const { toasts } = useToast()
    return <>{toasts.map((toast) => <div key={toast.id}>{toast.title}</div>)}</>
}

describe('SessionList directory action', () => {
    it('starts a new session with the project machine and directory', () => {
        const onNewSessionInDirectory = vi.fn()
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: 'Greeting',
                flavor: 'codex',
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={onNewSessionInDirectory}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))

        expect(onNewSessionInDirectory).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/home/ubuntu',
        })
    })

    it('hides the directory action for sessions without path metadata', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({ id: 'session-without-path' })]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        expect(screen.queryByRole('button', { name: 'New session in this directory' })).toBeNull()
    })
})

describe('SessionList resume command action', () => {
    it('copies the native resume command from the session row menu', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        const session = makeSession({
            id: 'session-codex',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: 'Codex session',
                flavor: 'codex',
                agentSessionId: 'thread-123'
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        fireEvent.contextMenu(screen.getByRole('button', { name: /Codex session/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy resume command' }))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('codex resume thread-123'))
        expect(await screen.findByText('Resume command copied')).toBeInTheDocument()
    })

    it('shows an error toast when clipboard access fails', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
        })
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            value: vi.fn().mockReturnValue(false)
        })
        const session = makeSession({
            id: 'session-codex',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: 'Codex session',
                flavor: 'codex',
                agentSessionId: 'thread-123'
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        fireEvent.contextMenu(screen.getByRole('button', { name: /Codex session/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy resume command' }))

        expect(await screen.findByText('Could not copy resume command')).toBeInTheDocument()
    })
})

describe('SessionList collapse behavior', () => {
    function renderSessionList(sessions: SessionSummary[], selectedSessionId = 'session-running') {
        return (
            <QueryClientProvider client={new QueryClient({
                defaultOptions: {
                    queries: { retry: false },
                    mutations: { retry: false },
                }
            })}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={sessions}
                            selectedSessionId={selectedSessionId}
                            onSelect={vi.fn()}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={false}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
    }

    function getProjectPanel(): Element {
        const header = screen.getByTitle('/work/hapi')
        const panel = header.nextElementSibling
        if (!panel) {
            throw new Error('Expected project collapse panel')
        }
        return panel
    }

    it('keeps a selected running path collapsed across live session-list refreshes', async () => {
        const baseSessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                pendingRequestsCount: 1,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-old',
                updatedAt: 50,
                metadata: { path: '/work/hapi', name: 'Older task', flavor: 'codex' },
            })
        ]
        const { rerender } = render(renderSessionList(baseSessions))

        expect(getProjectPanel().getAttribute('data-open')).toBe('true')

        fireEvent.click(screen.getByTitle('/work/hapi'))
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()

        rerender(renderSessionList([
            {
                ...baseSessions[0]!,
                pendingRequestsCount: 2,
                updatedAt: 200,
            },
            baseSessions[1]!
        ]))

        await waitFor(() => {
            expect(getProjectPanel().getAttribute('data-open')).toBeNull()
        })
    })

    it('auto-expands the path again when the selected session changes', async () => {
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-next',
                updatedAt: 90,
                metadata: { path: '/work/hapi', name: 'Next task', flavor: 'codex' },
            })
        ]
        const { rerender } = render(renderSessionList(sessions))

        fireEvent.click(screen.getByTitle('/work/hapi'))
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()

        rerender(renderSessionList(sessions, 'session-next'))

        await waitFor(() => {
            expect(getProjectPanel().getAttribute('data-open')).toBe('true')
        })
    })
})
