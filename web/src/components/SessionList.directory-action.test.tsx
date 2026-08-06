import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-session-preview-limit')
    localStorage.removeItem('hapi-pin-in-progress-sessions')
})

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
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
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
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

    it('keeps the sticky project header opaque and aligned with the list viewport', () => {
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
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
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        const projectHeader = screen.getByTitle('/home/ubuntu')
        expect(projectHeader).toHaveClass('bg-[var(--app-bg)]')
        expect(projectHeader).toHaveClass('hover:bg-[var(--app-secondary-bg)]')
        expect(projectHeader).not.toHaveClass('hover:bg-[var(--app-subtle-bg)]')

        const listContent = projectHeader.parentElement?.parentElement
        expect(listContent).not.toHaveClass('pt-1')

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        const searchInput = screen.getByPlaceholderText(/Search sessions/)
        const headerRow = searchInput.parentElement?.parentElement
        expect(headerRow).toHaveClass('px-2')
        expect(headerRow).toHaveClass('py-1')
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

describe('SessionList time filter', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 6, 18, 12))
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('keeps the date filter beside collapsed search and filters without expanding it', () => {
        const recent = makeSession({
            id: 'recent',
            updatedAt: Date.now(),
            metadata: { path: '/work/recent', name: 'Recent session' }
        })
        const old = makeSession({
            id: 'old',
            updatedAt: new Date(2020, 0, 1).getTime(),
            metadata: { path: '/work/old', name: 'Old session' }
        })

        renderWithProviders(
            <SessionList
                sessions={[recent, old]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        expect(screen.getByRole('button', { name: /Recent session/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Old session/ })).toBeInTheDocument()

        const searchButton = screen.getByRole('button', { name: 'Search sessions' })
        const filterButton = screen.getByRole('button', { name: 'Filter sessions by last activity' })
        expect(searchButton.nextElementSibling).toBe(filterButton)
        expect(searchButton.parentElement).toBe(filterButton.parentElement)
        expect(searchButton.parentElement).toHaveClass('relative', 'gap-1')
        expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()

        fireEvent.click(filterButton)
        const emptyDate = screen.getByRole('button', { name: new Date(2026, 6, 17).toLocaleDateString() })
        const activeDate = screen.getByRole('button', { name: `${new Date(2026, 6, 18).toLocaleDateString()}, has session activity` })
        expect(emptyDate).toHaveClass('text-[var(--app-hint)]')
        expect(activeDate).toHaveClass('text-[var(--app-fg)]')
        expect(activeDate).toHaveAttribute('title', `${new Date(2026, 6, 18).toLocaleDateString()}, has session activity`)
        fireEvent.click(emptyDate)
        fireEvent.click(activeDate)

        expect(screen.getByRole('button', { name: /Recent session/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Old session/ })).toBeNull()
        expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()
        expect(filterButton).toHaveAttribute('title', '2026-07-17 – 2026-07-18')
        expect(filterButton).toHaveAccessibleName('Filter sessions by last activity: 2026-07-17 – 2026-07-18')
        expect(filterButton).toHaveFocus()
    })

    it('highlights today without requiring hover or session activity', () => {
        const old = makeSession({
            id: 'old',
            updatedAt: new Date(2020, 0, 1).getTime(),
            metadata: { path: '/work/old', name: 'Old session' }
        })

        renderWithProviders(
            <SessionList
                sessions={[old]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by last activity' }))
        const today = screen.getByRole('button', { name: new Date(2026, 6, 18).toLocaleDateString() })
        const anotherDay = screen.getByRole('button', { name: new Date(2026, 6, 17).toLocaleDateString() })

        expect(today).toHaveClass('bg-[var(--app-subtle-bg)]')
        expect(today).toHaveAttribute('aria-current', 'date')
        expect(anotherDay).not.toHaveAttribute('aria-current')
    })

    it('uses the first calendar click as start and the second as end', () => {
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: { path: '/work/hapi', name: 'Session' }
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

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        const filterButton = screen.getByRole('button', { name: 'Filter sessions by last activity' })
        fireEvent.click(filterButton)
        const startDate = screen.getByRole('button', { name: new Date(2026, 6, 1).toLocaleDateString() })
        fireEvent.click(startDate)
        expect(startDate).toHaveClass('bg-[var(--app-button)]', 'text-[var(--app-button-text)]')
        expect(startDate).not.toHaveClass('text-white')
        expect(screen.getByText('Select end date')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: `${new Date(2026, 6, 18).toLocaleDateString()}, has session activity` }))

        expect(filterButton).toHaveAttribute('aria-expanded', 'false')
        expect(filterButton).toHaveAttribute('title', '2026-07-01 – 2026-07-18')
    })

    it('returns focus to the search input after clearing the date range', () => {
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: { path: '/work/hapi', name: 'Session' }
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

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        const input = screen.getByPlaceholderText('Search sessions…')
        const filterButton = screen.getByRole('button', { name: 'Filter sessions by last activity' })
        fireEvent.click(filterButton)
        fireEvent.click(screen.getByRole('button', { name: new Date(2026, 6, 1).toLocaleDateString() }))
        fireEvent.click(screen.getByRole('button', { name: `${new Date(2026, 6, 18).toLocaleDateString()}, has session activity` }))

        // The footer Clear button unmounts with the range; focus must not drop to body.
        fireEvent.click(filterButton)
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

        expect(input).toHaveFocus()
        expect(filterButton).toHaveAttribute('title', 'Filter sessions by last activity')
    })
})

describe('SessionList action menu parity', () => {
    it.each([
        ['running', true],
        ['closed', false]
    ] as const)('offers conversation export for a %s session', (_label, active) => {
        const session = makeSession({
            id: `session-${active ? 'running' : 'closed'}`,
            active,
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: active ? 'Running session' : 'Closed session',
                flavor: 'codex'
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

        fireEvent.contextMenu(screen.getByRole('button', { name: new RegExp(active ? 'Running session' : 'Closed session') }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Export conversation' }))

        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Export conversation' })).toBeInTheDocument()
    })
})

describe('SessionList collapse behavior', () => {
    function renderSessionList(sessions: SessionSummary[], selectedSessionId: string | null = 'session-running') {
        return (
            <QueryClientProvider client={new QueryClient({
                defaultOptions: {
                    queries: { retry: false },
                    mutations: { retry: false },
                }
            })}>
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
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
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

        // The running session is pinned in the "in progress" section; the
        // directory group now only holds inactive sessions and starts
        // collapsed.
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

    it('leaves active sessions in directory groups when pin-in-progress is off', () => {
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-idle',
                updatedAt: 50,
                metadata: { path: '/work/other', name: 'Other task', flavor: 'codex' },
            }),
        ]
        render(renderSessionList(sessions, null))

        expect(screen.queryByTitle('In progress')).toBeNull()
        expect(screen.getByTitle('/work/hapi')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Running task/ })).toBeInTheDocument()
        // Active group stays expanded by default so the project glance is immediate.
        expect(screen.getByTitle('/work/hapi').nextElementSibling?.getAttribute('data-open')).toBe('true')
    })

    it('pins active sessions into In progress when the preference is on', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-idle',
                updatedAt: 50,
                metadata: { path: '/work/hapi', name: 'Idle task', flavor: 'codex' },
            }),
        ]
        render(renderSessionList(sessions, null))

        expect(screen.getByTitle('In progress')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Running task/ })).toBeInTheDocument()
        // Directory group retains only the inactive session.
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()
    })

    it('does not label quiet active sessions as Idle', () => {
        const sessions = [
            makeSession({
                id: 'session-quiet',
                active: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Quiet task', flavor: 'codex' },
            }),
        ]
        render(renderSessionList(sessions, null))

        expect(screen.getByRole('button', { name: /Quiet task/ })).toBeInTheDocument()
        expect(screen.queryByText('Idle')).toBeNull()
        expect(screen.queryByTitle('Idle')).toBeNull()
    })

    it('keeps quiet active sessions in directory groups when pin-in-progress is on', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-quiet',
                active: true,
                updatedAt: 90,
                metadata: { path: '/work/hapi', name: 'Quiet task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-pending',
                active: true,
                pendingRequestsCount: 1,
                updatedAt: 80,
                metadata: { path: '/work/other', name: 'Pending task', flavor: 'codex' },
            }),
        ]
        render(renderSessionList(sessions, null))

        expect(screen.getByTitle('In progress')).toBeInTheDocument()
        expect(screen.getByText(/Running \(1\)/)).toBeInTheDocument()
        expect(screen.getByText(/pending \(1\)/)).toBeInTheDocument()
        expect(screen.queryByText(/Idle \(/)).toBeNull()
        // Quiet active stays under its project directory, not an Idle pin bucket.
        expect(screen.getByTitle('/work/hapi')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Quiet task/ })).toBeInTheDocument()
        expect(getProjectPanel().getAttribute('data-open')).toBe('true')
    })

    it('auto-expands the path again when the selected session changes', async () => {
        const sessions = [
            makeSession({
                id: 'session-first',
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

        // Inactive-only groups start collapsed; selecting a session inside
        // one auto-expands it.
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()

        rerender(renderSessionList([
            ...sessions,
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 110,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
        ], 'session-next'))

        await waitFor(() => {
            expect(getProjectPanel().getAttribute('data-open')).toBe('true')
        })
    })

    it('keeps the running section open while searching even when collapsed', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-idle',
                updatedAt: 50,
                metadata: { path: '/work/hapi', name: 'Idle task', flavor: 'codex' },
            }),
        ]
        render(renderSessionList(sessions))

        const runningPanel = () => screen.getByTitle('In progress').nextElementSibling

        expect(runningPanel()?.getAttribute('data-open')).toBe('true')
        expect(screen.getByTitle('In progress').getAttribute('aria-expanded')).toBe('true')

        fireEvent.click(screen.getByTitle('In progress'))
        expect(runningPanel()?.getAttribute('data-open')).toBeNull()
        expect(screen.getByTitle('In progress').getAttribute('aria-expanded')).toBe('false')

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        fireEvent.change(screen.getByPlaceholderText('Search sessions…'), {
            target: { value: 'Running' },
        })

        expect(runningPanel()?.getAttribute('data-open')).toBe('true')
        // The section stays reported open while searching even though the
        // underlying collapsed state is still set.
        expect(screen.getByTitle('In progress').getAttribute('aria-expanded')).toBe('true')
    })

    it('toggles the running section with the keyboard', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
        ]
        render(renderSessionList(sessions))

        const header = screen.getByRole('button', { name: /In progress/ })
        expect(header.getAttribute('aria-expanded')).toBe('true')

        fireEvent.keyDown(header, { key: 'Enter' })
        expect(header.getAttribute('aria-expanded')).toBe('false')

        fireEvent.keyDown(header, { key: ' ' })
        expect(header.getAttribute('aria-expanded')).toBe('true')
    })

    it('keeps the previous selected path open when selection moves', async () => {
        const sessions = [
            makeSession({
                id: 'session-first',
                updatedAt: 100,
                metadata: { path: '/work/first', name: 'First task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-second',
                updatedAt: 90,
                metadata: { path: '/work/second', name: 'Second task', flavor: 'codex' },
            })
        ]
        const { rerender } = render(renderSessionList(sessions, 'session-first'))
        const firstPanel = screen.getByTitle('/work/first').nextElementSibling

        expect(firstPanel?.getAttribute('data-open')).toBe('true')

        rerender(renderSessionList(sessions, 'session-second'))

        await waitFor(() => {
            expect(firstPanel?.getAttribute('data-open')).toBe('true')
        })
    })

    it('keeps the configured session preview fold while searching', () => {
        localStorage.setItem('hapi-session-preview-limit', '2')
        const sessions = Array.from({ length: 4 }, (_, index) => makeSession({
            id: `matching-${index + 1}`,
            updatedAt: 100 - index,
            metadata: {
                path: '/work/hapi',
                name: `Matching task ${index + 1}`,
                flavor: 'codex',
            },
        }))

        render(renderSessionList(sessions, null))
        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        fireEvent.change(screen.getByPlaceholderText('Search sessions…'), {
            target: { value: 'Matching task' },
        })

        expect(screen.getByRole('button', { name: /Matching task 1/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Matching task 2/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Matching task 3/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Matching task 4/ })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Expand 2' }))

        expect(screen.getByRole('button', { name: /Matching task 3/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Matching task 4/ })).toBeInTheDocument()
    })

    it('expands and collapses the session preview one batch at a time', () => {
        localStorage.setItem('hapi-session-preview-limit', '2')
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `session-${index + 1}`,
            updatedAt: 100 - index,
            metadata: {
                path: '/work/hapi',
                name: `Task ${index + 1}`,
                flavor: 'codex',
            },
        }))

        render(renderSessionList(sessions, null))

        expect(screen.getByRole('button', { name: 'Expand 2' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Collapse 2' })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Expand 2' }))

        expect(screen.getByRole('button', { name: /Task 4/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Task 5/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Collapse 2' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Expand 2' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Expand 2' }))

        expect(screen.getByRole('button', { name: /Task 6/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Collapse 2' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Expand 2' })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse 2' }))

        expect(screen.queryByRole('button', { name: /Task 5/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Collapse 2' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Expand 2' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse 2' }))

        expect(screen.queryByRole('button', { name: /Task 3/ })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Collapse 2' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Expand 2' })).toBeInTheDocument()
    })

    it('does not offer a no-op collapse when required sessions exceed the preview limit', () => {
        localStorage.setItem('hapi-session-preview-limit', '2')
        const sessions = Array.from({ length: 4 }, (_, index) => makeSession({
            id: `session-${index + 1}`,
            updatedAt: 100 - index,
            pendingRequestsCount: index > 0 ? 1 : 0,
            metadata: {
                path: '/work/hapi',
                name: `Task ${index + 1}`,
                flavor: 'codex',
            },
        }))

        render(renderSessionList(sessions, null))

        expect(screen.queryByRole('button', { name: /Collapse/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Task 1/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Expand 1' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Expand 1' }))

        expect(screen.getByRole('button', { name: /Task 1/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Collapse 1' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse 1' }))

        expect(screen.queryByRole('button', { name: /Task 1/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Collapse/ })).toBeNull()
    })

    it('expands from the rendered count when required sessions exceed the preview limit', () => {
        localStorage.setItem('hapi-session-preview-limit', '2')
        const sessions = Array.from({ length: 8 }, (_, index) => makeSession({
            id: `session-${index + 1}`,
            updatedAt: 100 - index,
            pendingRequestsCount: index < 5 ? 1 : 0,
            metadata: {
                path: '/work/hapi',
                name: `Task ${index + 1}`,
                flavor: 'codex',
            },
        }))

        render(renderSessionList(sessions, null))

        expect(screen.getByRole('button', { name: /Task 5/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Task 6/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Expand 2' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Expand 2' }))

        expect(screen.getByRole('button', { name: /Task 6/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Task 7/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Task 8/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Expand 1' })).toBeInTheDocument()
    })
})

describe('SessionList search toggle', () => {
    it('expands on icon click and keeps filtering after collapsing on blur', () => {
        const sessions = [
            makeSession({
                id: 'session-match',
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Matching task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-other',
                updatedAt: 90,
                metadata: { path: '/work/hapi', name: 'Other task', flavor: 'codex' },
            }),
        ]

        renderWithProviders(
            <SessionList
                sessions={sessions}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        // Collapsed by default: only the toggle icon is rendered.
        expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        const input = screen.getByPlaceholderText('Search sessions…')
        expect(input).toHaveFocus()

        fireEvent.change(input, { target: { value: 'Matching' } })
        expect(screen.getByRole('button', { name: /Matching task/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Other task/ })).toBeNull()

        // Blur collapses back to the icon; the query stays applied.
        fireEvent.blur(input)
        expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()
        expect(screen.getByRole('button', { name: /Search sessions/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Matching task/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Other task/ })).toBeNull()
    })

    it('shows truncated query text on the collapsed search control when a text filter is active', () => {
        const sessions = [
            makeSession({
                id: 'session-jelly',
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'jellybot task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-other',
                updatedAt: 90,
                metadata: { path: '/work/hapi', name: 'Other task', flavor: 'codex' },
            }),
        ]

        renderWithProviders(
            <SessionList
                sessions={sessions}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        const input = screen.getByPlaceholderText('Search sessions…')
        fireEvent.change(input, { target: { value: 'jellybot' } })
        fireEvent.blur(input)

        expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()
        const collapsed = screen.getByRole('button', { name: /Search sessions/ })
        expect(collapsed).toHaveTextContent('jellybot')
        expect(collapsed.className).toContain('bg-[var(--app-chat-user-chip-bg)]')
        expect(collapsed.className).toContain('text-[var(--app-chat-user-chip-fg)]')
        expect(screen.getByRole('button', { name: /jellybot task/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Other task/ })).toBeNull()
    })

    it('stays expanded with focus on the input after clearing the query', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({
                    id: 'session-1',
                    updatedAt: 100,
                    metadata: { path: '/work/hapi', name: 'Task', flavor: 'codex' },
                })]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        const input = screen.getByPlaceholderText('Search sessions…')
        fireEvent.change(input, { target: { value: 'Task' } })

        // The clear button unmounts itself; focus must return to the input so a
        // later outside click still collapses the search via the wrapper blur.
        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

        expect(input).toHaveFocus()
        expect(input).toHaveValue('')
        expect(screen.getByPlaceholderText('Search sessions…')).toBeInTheDocument()
    })

    it('keeps header actions visible when sessions become empty while search is expanded', () => {
        const renderList = (sessions: SessionSummary[]) => (
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
                            selectedSessionId={null}
                            onSelect={vi.fn()}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={false}
                            headerActions={<button type="button">Refresh</button>}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
        const { rerender } = render(renderList([
            makeSession({
                id: 'session-1',
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Task', flavor: 'codex' },
            }),
        ]))

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()

        rerender(renderList([]))

        expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Search sessions' })).toBeNull()
    })
})
