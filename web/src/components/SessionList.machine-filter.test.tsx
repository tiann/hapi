import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const SEARCH_LABEL = 'Search sessions (title, path, Agent, machine name, ID, and more)'
const SEARCH_PLACEHOLDER = 'Search title/path/Agent/machine/ID…'

afterEach(() => cleanup())

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

function renderSessionList(sessions: SessionSummary[], api: ApiClient | null = null) {
    return renderWithProviders(
        <SessionList
            sessions={sessions}
            selectedSessionId={null}
            onSelect={vi.fn()}
            onNewSession={vi.fn()}
            onRefresh={vi.fn()}
            isLoading={false}
            renderHeader={false}
            api={api}
            machineLabelsById={{ 'machine-1': 'Mint', 'machine-2': 'Teemo' }}
        />
    )
}

const multiMachineSessions = [
    makeSession({
        id: 'session-m1',
        updatedAt: 100,
        metadata: { path: '/work/hapi', machineId: 'machine-1', agentSessionId: 'thread-1' }
    }),
    makeSession({
        id: 'session-m2',
        updatedAt: 90,
        metadata: { path: '/work/docs', machineId: 'machine-2', agentSessionId: 'thread-2' }
    })
]

describe('SessionList machine filter', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('hides the filter bar when all sessions are on a single machine', () => {
        renderSessionList([
            makeSession({
                id: 'session-1',
                updatedAt: 100,
                metadata: { path: '/work/hapi', machineId: 'machine-1', agentSessionId: 'thread-1' }
            })
        ])

        expect(screen.queryByRole('group', { name: 'Filter by machine' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Filter by machine' })).toBeNull()
        expect(screen.getByTitle('/work/hapi')).toBeTruthy()
    })

    it('shows the filter bar and machine-suffixed group titles with multiple machines', () => {
        renderSessionList(multiMachineSessions)

        expect(screen.getByRole('group', { name: 'Filter by machine' })).toBeTruthy()
        // Mobile (below md) counterpart: the session and machine filters share
        // one compact filter icon and menu.
        const filterButtons = screen.getAllByRole('button', { name: 'Filter sessions' })
        expect(filterButtons.some((button) => button.parentElement?.className.includes('md:hidden'))).toBe(true)
        expect(screen.getByRole('button', { name: /All \(2\)/ })).toBeTruthy()
        expect(screen.getByText('work/hapi · Mint')).toBeTruthy()
        expect(screen.getByText('work/docs · Teemo')).toBeTruthy()
    })

    it('filters directory groups when a machine chip is selected', () => {
        renderSessionList(multiMachineSessions)

        fireEvent.click(screen.getByRole('button', { name: /Teemo \(1\)/ }))

        expect(screen.queryByTitle('/work/hapi')).toBeNull()
        expect(screen.getByTitle('/work/docs')).toBeTruthy()
        // Suffix disappears once a single machine is selected
        expect(screen.getByText('work/docs')).toBeTruthy()
        expect(window.localStorage.getItem('hapi-session-list-machine-filter')).toBe('machine-2')
    })

    it('falls back to All when the persisted machine no longer has sessions', () => {
        window.localStorage.setItem('hapi-session-list-machine-filter', 'gone-machine')
        renderSessionList(multiMachineSessions)

        expect(screen.getByTitle('/work/hapi')).toBeTruthy()
        expect(screen.getByTitle('/work/docs')).toBeTruthy()
        expect(screen.getByRole('button', { name: /All \(2\)/ }).getAttribute('aria-pressed')).toBe('true')
    })

    it('shows an empty state when the search only matches sessions on another machine', () => {
        renderSessionList([
            makeSession({
                id: 'session-alpha',
                updatedAt: 100,
                metadata: { path: '/work/hapi', machineId: 'machine-1', agentSessionId: 'thread-1', name: 'Alpha task' }
            }),
            makeSession({
                id: 'session-beta',
                updatedAt: 90,
                metadata: { path: '/work/docs', machineId: 'machine-2', agentSessionId: 'thread-2', name: 'Beta task' }
            })
        ])

        fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
        fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'alpha' } })
        fireEvent.click(screen.getByRole('button', { name: /Teemo \(1\)/ }))

        expect(screen.getByText('No sessions match your filters.')).toBeTruthy()
        expect(screen.queryByTitle('/work/hapi')).toBeNull()
        expect(screen.queryByTitle('/work/docs')).toBeNull()
    })

    it('combines session and machine options in the mobile filter menu', () => {
        renderSessionList(multiMachineSessions)

        const mobileTrigger = screen.getAllByRole('button', { name: 'Filter sessions' })
            .find((button) => button.parentElement?.className.includes('md:hidden'))
        expect(mobileTrigger).toBeTruthy()
        fireEvent.click(mobileTrigger!)

        const menu = screen.getByRole('menu', { name: 'Filter sessions' })
        expect(within(menu).getByRole('group', { name: 'Session' })).toBeTruthy()
        expect(within(menu).getByRole('group', { name: 'Filter by machine' })).toBeTruthy()
        expect(Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]')).map((item) => item.textContent?.replace(/\s+/g, ''))).toEqual([
            'Unread',
            'Date',
            'Scratchlist',
            'All(2)',
            'Mint(1)',
            'Teemo(1)'
        ])
        expect(within(menu).getByRole('menuitemradio', { name: /All \(2\)/ })).toBeTruthy()
        expect(within(menu).getByRole('menuitemradio', { name: /Mint \(1\)/ })).toBeTruthy()
        expect(within(menu).getByRole('menuitemradio', { name: /Teemo \(1\)/ })).toBeTruthy()
    })
})

describe('SessionList session filter menu', () => {
    it('lists unread, date, and scratchlist and closes when clicking outside', () => {
        renderSessionList([
            makeSession({ id: 'session-1', metadata: { path: '/work/hapi', name: 'Session one' } })
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))

        const menu = screen.getByRole('menu', { name: 'Filter sessions' })
        expect(Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]')).map((item) => item.textContent)).toEqual([
            'Unread',
            'Date',
            'Scratchlist'
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        expect(screen.queryByRole('menu', { name: 'Filter sessions' })).toBeNull()
    })

    it('opens the existing date picker from the unified filter menu', () => {
        renderSessionList([
            makeSession({ id: 'session-1', metadata: { path: '/work/hapi', name: 'Session one' } })
        ])

        expect(screen.queryByRole('button', { name: 'Filter sessions by last activity' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))

        const menu = screen.getByRole('menu', { name: 'Filter sessions' })
        fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Date' }))

        expect(screen.getByRole('menu', { name: 'Filter sessions' })).toBeTruthy()
        expect(screen.getByRole('dialog', { name: 'Filter sessions by last activity' })).toBeTruthy()
    })

    it('filters by scratchlist session ids using one batch request', async () => {
        const getScratchlistSessionIds = vi.fn().mockResolvedValue(['session-with-draft'])
        const api = { getScratchlistSessionIds } as unknown as ApiClient
        renderSessionList([
            makeSession({ id: 'session-with-draft', metadata: { path: '/work/draft', name: 'Draft session' } }),
            makeSession({ id: 'session-without-draft', metadata: { path: '/work/empty', name: 'Empty session' } })
        ], api)

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Scratchlist' }))

        await waitFor(() => expect(getScratchlistSessionIds).toHaveBeenCalledTimes(1))
        await waitFor(() => {
            expect(screen.getByTitle('/work/draft')).toBeTruthy()
            expect(screen.queryByTitle('/work/empty')).toBeNull()
        })
    })

    it('allows unread and scratchlist filters to be selected together', async () => {
        window.localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({
            'draft-unread': 0,
            'draft-seen': 1_000,
            'plain-unread': 0
        }))
        const getScratchlistSessionIds = vi.fn().mockResolvedValue(['draft-unread', 'draft-seen'])
        const api = { getScratchlistSessionIds } as unknown as ApiClient
        renderSessionList([
            makeSession({ id: 'draft-unread', updatedAt: 500, metadata: { path: '/work/draft-unread', name: 'Draft unread' } }),
            makeSession({ id: 'draft-seen', updatedAt: 500, metadata: { path: '/work/draft-seen', name: 'Draft seen' } }),
            makeSession({ id: 'plain-unread', updatedAt: 500, metadata: { path: '/work/plain-unread', name: 'Plain unread' } })
        ], api)

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread' }))
        expect(screen.getByRole('menu', { name: 'Filter sessions' })).toBeTruthy()
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Scratchlist' }))

        await waitFor(() => expect(getScratchlistSessionIds).toHaveBeenCalledTimes(1))
        await waitFor(() => {
            expect(screen.getByTitle('/work/draft-unread')).toBeTruthy()
            expect(screen.queryByTitle('/work/draft-seen')).toBeNull()
            expect(screen.queryByTitle('/work/plain-unread')).toBeNull()
        })
    })

    it('keeps the existing unread filter behavior behind the unified menu', () => {
        window.localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({
            'session-unread': 100,
            'session-seen': 1_000
        }))
        renderSessionList([
            makeSession({ id: 'session-unread', updatedAt: 500, metadata: { path: '/work/unread', name: 'Unread session' } }),
            makeSession({ id: 'session-seen', updatedAt: 500, metadata: { path: '/work/seen', name: 'Seen session' } })
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread' }))

        expect(screen.getByTitle('/work/unread')).toBeTruthy()
        expect(screen.queryByTitle('/work/seen')).toBeNull()
    })
})
