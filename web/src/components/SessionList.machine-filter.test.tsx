import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine, SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList, SessionListSearch } from './SessionList'

const SEARCH_LABEL = 'Search sessions (title, path, Agent, machine name, ID, and more)'
const SEARCH_PLACEHOLDER = 'Search title/path/Agent/machine/ID…'
const SEARCH_SCOPE_LABEL = 'Search scope'

afterEach(() => cleanup())
beforeEach(() => window.localStorage.clear())

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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
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

function makeMachine(overrides: Partial<Machine> & { id: string }): Machine {
    return {
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        runnerState: null,
        runnerStateVersion: 0,
        health: null,
        ...overrides
    }
}

function renderSessionList(
    sessions: SessionSummary[],
    apiOrMachinesById?: ApiClient | null | Record<string, Machine>,
    onRefresh: () => Promise<unknown> | void = vi.fn(),
    machinesByIdParam?: Record<string, Machine>
) {
    const isApiClient = Boolean(
        apiOrMachinesById &&
        ('getScratchlistSessionIds' in apiOrMachinesById || typeof (apiOrMachinesById as any).fetch === 'function')
    )
    const api = isApiClient ? (apiOrMachinesById as ApiClient) : null
    const machinesById = isApiClient
        ? machinesByIdParam
        : (apiOrMachinesById && !('getScratchlistSessionIds' in apiOrMachinesById)
            ? (apiOrMachinesById as Record<string, Machine>)
            : undefined)
    return renderWithProviders(
        <SessionList
            sessions={sessions}
            selectedSessionId={null}
            onSelect={vi.fn()}
            onNewSession={vi.fn()}
            onRefresh={onRefresh}
            isLoading={false}
            renderHeader={false}
            api={api}
            machineLabelsById={{ 'machine-1': 'Mint', 'machine-2': 'Teemo' }}
            machinesById={machinesById}
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

    it('shows a compact summary row instead of filter chips on a single machine', () => {
        renderSessionList([
            makeSession({
                id: 'session-1',
                updatedAt: 100,
                metadata: { path: '/work/hapi', machineId: 'machine-1', agentSessionId: 'thread-1' }
            })
        ])

        // One machine has nothing to filter — no bar, no mobile filter menu.
        expect(screen.queryByRole('group', { name: 'Filter sessions by machine' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Filter sessions by machine' })).toBeNull()
        // The machine label and session count stay visible.
        const summary = screen.getByText('Mint').parentElement!
        expect(within(summary).getByText('(1)')).toBeTruthy()
        expect(screen.getByTitle('/work/hapi')).toBeTruthy()
    })

    it('shows machine health inline on the single-machine summary row', () => {
        renderSessionList(
            [
                makeSession({
                    id: 'session-1',
                    updatedAt: 100,
                    metadata: { path: '/work/hapi', machineId: 'machine-1', agentSessionId: 'thread-1' }
                })
            ],
            {
                'machine-1': makeMachine({
                    id: 'machine-1',
                    health: { collectedAt: 100, cpuPercent: 12, memoryPercent: 88 }
                })
            }
        )

        expect(screen.getByText('CPU 12% · RAM 88%')).toBeTruthy()
    })

    it('shows the summary row for a sole machine with no visible sessions', () => {
        // Fresh install / "active only" filtering: zero session groups, but the
        // sole machine is online and its health must stay visible.
        renderSessionList(
            [],
            {
                'machine-1': makeMachine({
                    id: 'machine-1',
                    health: { collectedAt: 100, cpuPercent: 12, memoryPercent: 88 }
                })
            }
        )

        const summary = screen.getByText('Mint').parentElement!
        expect(within(summary).getByText('(0)')).toBeTruthy()
        expect(screen.getByText('CPU 12% · RAM 88%')).toBeTruthy()
    })

    it('shows the filter bar and machine-suffixed group titles with multiple machines', () => {
        renderSessionList(multiMachineSessions)

        expect(screen.getByRole('group', { name: 'Filter sessions by machine' })).toBeTruthy()
        // Mobile (below md) counterpart: the session and machine filters share
        // one compact filter icon and menu.
        const filterButtons = screen.getAllByRole('button', { name: 'Sort and filter' })
        expect(filterButtons).toHaveLength(1)
        expect(screen.getByRole('button', { name: /All \(2\)/ })).toBeTruthy()
        expect(screen.getByText('work/hapi · Mint')).toBeTruthy()
        expect(screen.getByText('work/docs · Teemo')).toBeTruthy()
    })

    it('filters directory groups when a machine chip is selected', () => {
        renderSessionList(multiMachineSessions)

        fireEvent.click(screen.getByRole('button', { name: /^Teemo \(1\)/ }))

        expect(screen.queryByTitle('/work/hapi')).toBeNull()
        expect(screen.getByTitle('/work/docs')).toBeTruthy()
        // Suffix disappears once a single machine is selected
        expect(screen.getByText('work/docs')).toBeTruthy()
        expect(window.localStorage.getItem('hapi-session-list-machine-filter')).toBe('machine-2')
    })

    it('uses the persisted unread view as the unified filter state through patches and reset', () => {
        window.localStorage.setItem('hapi-session-list-unread-only', 'true')
        const readState = (readRevision: number) => ({ readRevision, manualUnread: false, version: 0 })
        renderSessionList([
            makeSession({ id: 'unread-only', updatedAt: 500, contentRevision: 1, readState: readState(0), metadata: { path: '/work/unread', name: 'Unread row' } }),
            makeSession({ id: 'read-only', updatedAt: 500, contentRevision: 1, readState: readState(1), metadata: { path: '/work/read', name: 'Read row' } })
        ])

        expect(screen.queryByTitle('/work/read')).toBeNull()
        const viewButton = screen.getAllByTestId('session-list-view-button').find(button => !button.closest('[inert]'))!
        fireEvent.click(viewButton)
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Date created' }))

        expect(screen.getByRole('menuitemcheckbox', { name: 'Unread only' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.queryByTitle('/work/read')).toBeNull()

        fireEvent.click(screen.getByRole('menuitem', { name: 'Reset to default' }))
        expect(screen.getByRole('menuitemcheckbox', { name: 'Unread only' })).toHaveAttribute('aria-checked', 'false')
        expect(screen.getByTitle('/work/read')).toBeTruthy()
    })

    it('preserves a selected machine when unread filtering has no matches for it', () => {
        const readState = (readRevision: number) => ({ readRevision, manualUnread: false, version: 0 })
        renderSessionList([
            makeSession({
                id: 'unread-m1',
                updatedAt: 500,
                contentRevision: 1,
                readState: readState(0),
                metadata: { path: '/work/m1-unread', machineId: 'machine-1', name: 'Unread on Mint' }
            }),
            makeSession({
                id: 'read-m2',
                updatedAt: 500,
                contentRevision: 1,
                readState: readState(1),
                metadata: { path: '/work/m2-read', machineId: 'machine-2', name: 'Read on Teemo' }
            })
        ])

        const teemo = screen.getByRole('button', { name: /^Teemo \(1\)$/ })
        fireEvent.click(teemo)
        expect(teemo).toHaveAttribute('aria-pressed', 'true')

        fireEvent.click(screen.getAllByRole('button', { name: 'Sort and filter' })[0])
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread only' }))

        expect(screen.getByRole('button', { name: /^Teemo \(1\)$/ })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.queryByTitle('/work/m1-unread')).toBeNull()
        expect(screen.queryByTitle('/work/m2-read')).toBeNull()
        expect(screen.getByText('No sessions match your filters.')).toBeTruthy()
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
        fireEvent.click(screen.getByRole('button', { name: /^Teemo \(1\)/ }))

        expect(screen.getByText('No sessions match your filters.')).toBeTruthy()
        expect(screen.queryByTitle('/work/hapi')).toBeNull()
        expect(screen.queryByTitle('/work/docs')).toBeNull()
    })

    it('excludes the desktop session filter from the mobile toolbar budget', () => {
        vi.stubGlobal('matchMedia', vi.fn(() => ({
            matches: false,
            media: '(min-width: 768px)',
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn()
        })))
        try {
            renderSessionList(multiMachineSessions, {
                'machine-1': makeMachine({ id: 'machine-1' }),
                'machine-2': makeMachine({ id: 'machine-2' })
            })

            fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
            const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER)
            fireEvent.change(input, { target: { value: 'a very long collapsed session search query' } })
            fireEvent.blur(input)

            const actions = screen.getByTestId('session-list-header-actions')
            expect(screen.getAllByRole('button', { name: 'Sort and filter' })).toHaveLength(1)
            expect(document.querySelector('[data-measure-id="session-filter"]')).toBeNull()
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('combines session and machine options in the mobile filter menu', () => {
        renderSessionList(multiMachineSessions)

        const mobileTrigger = screen.getAllByRole('button', { name: 'Sort and filter' })
            .find((button) => !button.closest('[inert]'))
        expect(mobileTrigger).toBeTruthy()
        fireEvent.click(mobileTrigger!)

        const menu = screen.getByRole('menu', { name: 'Sort and filter' })
        expect(within(menu).getByRole('group', { name: 'Show' })).toBeTruthy()
        expect(within(menu).getByRole('group', { name: 'Filter sessions by machine' })).toBeTruthy()
        expect(Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]')).map((item) => item.textContent?.replace(/\s+/g, ''))).toEqual([
            'Lastmessage',
            'Datecreated',
            'Activefirst',
            'Allsessions',
            'Activeonly',
            'Archivedonly',
            'Unreadonly',
            'Updateddate',
            'Withdraftsonly',
            'All(2)',
            'Mint(1)',
            'Teemo(1)'
        ])
        expect(within(menu).getByRole('menuitemradio', { name: /All \(2\)/ })).toBeTruthy()
        expect(within(menu).getByRole('menuitemradio', { name: /Mint \(1\)/ })).toBeTruthy()
        expect(within(menu).getByRole('menuitemradio', { name: /^Teemo \(1\)$/ })).toBeTruthy()
    })
})

describe('SessionList session filter menu', () => {
    it('lists unread, date, and scratchlist and closes when clicking outside', () => {
        renderSessionList([
            makeSession({ id: 'session-1', metadata: { path: '/work/hapi', name: 'Session one' } })
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))

        const menu = screen.getByRole('menu', { name: 'Sort and filter' })
        expect(Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]')).map((item) => item.textContent)).toEqual([
            'Last message',
            'Date created',
            'Active first',
            'All sessions',
            'Active only',
            'Archived only',
            'Unread only',
            'Updated date',
            'With drafts only'
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        expect(screen.queryByRole('menu', { name: 'Sort and filter' })).toBeNull()
    })

    it('opens the existing date picker from the unified filter menu with high stacking context and navigates months', () => {
        renderSessionList([
            makeSession({ id: 'session-1', metadata: { path: '/work/hapi', name: 'Session one' } })
        ])

        expect(screen.queryByRole('button', { name: 'Filter sessions by update date' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))

        const menu = screen.getByRole('menu', { name: 'Sort and filter' })
        fireEvent.click(within(menu).getByRole('menuitem', { name: 'Updated date' }))

        expect(screen.getByRole('menu', { name: 'Sort and filter' })).toBeTruthy()
        const dialog = screen.getByRole('dialog', { name: 'Filter sessions by update date' })
        expect(dialog).toBeTruthy()
        expect(dialog.className).toContain('z-[60]')

        const prevMonthButton = within(dialog).getByRole('button', { name: 'Previous month' })
        const nextMonthButton = within(dialog).getByRole('button', { name: 'Next month' })
        expect(prevMonthButton).toBeTruthy()
        expect(nextMonthButton).toBeTruthy()
        fireEvent.click(prevMonthButton)
        fireEvent.click(nextMonthButton)

        const dayButtons = within(dialog).getAllByRole('button').filter(b => /^\d+$/.test(b.textContent?.trim() || ''))
        expect(dayButtons.length).toBeGreaterThan(0)
        fireEvent.click(dayButtons[0])
        fireEvent.click(dayButtons[Math.min(5, dayButtons.length - 1)])
        expect(screen.queryByRole('dialog', { name: 'Filter sessions by update date' })).toBeNull()
    })

    it('filters by scratchlist session ids using one batch request', async () => {
        const getScratchlistSessionIds = vi.fn().mockResolvedValue(['session-with-draft'])
        const api = { getScratchlistSessionIds } as unknown as ApiClient
        renderSessionList([
            makeSession({ id: 'session-with-draft', metadata: { path: '/work/draft', name: 'Draft session' } }),
            makeSession({ id: 'session-without-draft', metadata: { path: '/work/empty', name: 'Empty session' } })
        ], api)

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'With drafts only' }))

        await waitFor(() => expect(getScratchlistSessionIds).toHaveBeenCalledTimes(1))
        await waitFor(() => {
            expect(screen.getByTitle('/work/draft')).toBeTruthy()
            expect(screen.queryByTitle('/work/empty')).toBeNull()
        })
    })

    it('retries scratchlist status after a request failure', async () => {
        const getScratchlistSessionIds = vi.fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce(['session-with-draft'])
        const api = { getScratchlistSessionIds } as unknown as ApiClient
        renderSessionList([
            makeSession({ id: 'session-with-draft', metadata: { path: '/work/draft', name: 'Draft session' } }),
            makeSession({ id: 'session-without-draft', metadata: { path: '/work/empty', name: 'Empty session' } })
        ], api)

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'With drafts only' }))

        await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

        await waitFor(() => {
            expect(getScratchlistSessionIds).toHaveBeenCalledTimes(2)
            expect(screen.getByTitle('/work/draft')).toBeTruthy()
            expect(screen.queryByTitle('/work/empty')).toBeNull()
        })
    })

    it('refreshes scratchlist status with pull-to-refresh', async () => {
        const getScratchlistSessionIds = vi.fn().mockResolvedValue(['session-with-draft'])
        const onRefresh = vi.fn().mockResolvedValue(undefined)
        const api = { getScratchlistSessionIds } as unknown as ApiClient
        renderSessionList([
            makeSession({ id: 'session-with-draft', metadata: { path: '/work/draft', name: 'Draft session' } })
        ], api, onRefresh)

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'With drafts only' }))
        await waitFor(() => expect(getScratchlistSessionIds).toHaveBeenCalledTimes(1))

        const scrollContainer = document.querySelector('.session-list-scrollbar-left') as HTMLElement
        fireEvent.touchStart(scrollContainer, { touches: [{ clientY: 100 }] })
        fireEvent.touchMove(scrollContainer, { touches: [{ clientY: 180 }] })
        fireEvent.touchEnd(scrollContainer)

        await waitFor(() => {
            expect(onRefresh).toHaveBeenCalledTimes(1)
            expect(getScratchlistSessionIds).toHaveBeenCalledTimes(2)
        })
    })

    it('allows unread and scratchlist filters to be selected together', async () => {
        const readState = (readRevision: number) => ({ readRevision, manualUnread: false, version: 0 })
        const getScratchlistSessionIds = vi.fn().mockResolvedValue(['draft-unread', 'draft-seen'])
        const api = { getScratchlistSessionIds } as unknown as ApiClient
        renderSessionList([
            makeSession({ id: 'draft-unread', updatedAt: 500, contentRevision: 1, readState: readState(0), metadata: { path: '/work/draft-unread', name: 'Draft unread' } }),
            makeSession({ id: 'draft-seen', updatedAt: 500, contentRevision: 1, readState: readState(1), metadata: { path: '/work/draft-seen', name: 'Draft seen' } }),
            makeSession({ id: 'plain-unread', updatedAt: 500, contentRevision: 1, readState: readState(0), metadata: { path: '/work/plain-unread', name: 'Plain unread' } })
        ], api)

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread only' }))
        expect(screen.getByRole('menu', { name: 'Sort and filter' })).toBeTruthy()
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'With drafts only' }))

        await waitFor(() => expect(getScratchlistSessionIds).toHaveBeenCalledTimes(1))
        await waitFor(() => {
            expect(screen.getByTitle('/work/draft-unread')).toBeTruthy()
            expect(screen.queryByTitle('/work/draft-seen')).toBeNull()
            expect(screen.queryByTitle('/work/plain-unread')).toBeNull()
        })
    })

    it('keeps the existing unread filter behavior behind the unified menu', () => {
        const readState = (readRevision: number) => ({ readRevision, manualUnread: false, version: 0 })
        renderSessionList([
            makeSession({ id: 'session-unread', updatedAt: 500, contentRevision: 1, readState: readState(0), metadata: { path: '/work/unread', name: 'Unread session' } }),
            makeSession({ id: 'session-seen', updatedAt: 500, contentRevision: 1, readState: readState(1), metadata: { path: '/work/seen', name: 'Seen session' } })
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread only' }))

        expect(screen.getByTitle('/work/unread')).toBeTruthy()
        expect(screen.queryByTitle('/work/seen')).toBeNull()
    })
    it('uses the search scope dropdown to exclude matching sessions', () => {
        renderSessionList([
            makeSession({
                id: 'session-match',
                updatedAt: 100,
                metadata: { path: '/work/archive', machineId: 'machine-1', name: 'Archive task' }
            }),
            makeSession({
                id: 'session-keep',
                updatedAt: 90,
                metadata: { path: '/work/hapi', machineId: 'machine-1', name: 'Current task' }
            })
        ])

        fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
        const scopeButton = screen.getByRole('button', { name: SEARCH_SCOPE_LABEL })
        expect(scopeButton).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(scopeButton)

        expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Exclude' }))
        expect(scopeButton).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByTitle('/work/archive')).toBeTruthy()
        expect(screen.getByTitle('/work/hapi')).toBeTruthy()

        fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'archive' } })

        expect(screen.queryByTitle('/work/archive')).toBeNull()
        expect(screen.getByTitle('/work/hapi')).toBeTruthy()
    })

    it('keeps the reusable search component inclusion-only without the mode callback', () => {
        renderWithProviders(
            <SessionListSearch
                value=""
                onChange={vi.fn()}
                expanded
                onExpandedChange={vi.fn()}
            />
        )

        expect(screen.queryByRole('button', { name: SEARCH_SCOPE_LABEL })).toBeNull()
    })

    it('returns focus to the input so an outside blur still collapses search', () => {
        renderSessionList([
            makeSession({
                id: 'session-focus',
                updatedAt: 100,
                metadata: { path: '/work/focus', machineId: 'machine-1', name: 'Focus test' }
            })
        ])

        fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
        const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER)
        fireEvent.click(screen.getByRole('button', { name: SEARCH_SCOPE_LABEL }))
        fireEvent.click(screen.getByRole('button', { name: 'Exclude' }))

        expect(input).toHaveFocus()
        fireEvent.blur(input, { relatedTarget: document.body })

        expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull()
        expect(screen.getByRole('button', { name: SEARCH_LABEL })).toBeTruthy()
    })

})
