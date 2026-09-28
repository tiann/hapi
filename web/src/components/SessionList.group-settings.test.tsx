import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { GROUP_SETTINGS_STORAGE_KEY } from '@/lib/groupSettings'
import { SessionList } from './SessionList'

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
    return render(
        <QueryClientProvider client={new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false },
            }
        })}>
            <ToastProvider>
                <I18nProvider>{children}</I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

function renderSessionList(sessions: SessionSummary[]) {
    return renderWithProviders(
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
}

const ALPHA_PATH = '/work/alpha'
const BETA_PATH = '/work/beta'
const ALPHA_KEY = 'machine-1::/work/alpha'
const BETA_KEY = 'machine-1::/work/beta'

function makeGroupSessions(): SessionSummary[] {
    return [
        makeSession({
            id: 'alpha-1',
            updatedAt: 1_000,
            metadata: { path: ALPHA_PATH, machineId: 'machine-1', name: 'Alpha session' }
        }),
        makeSession({
            id: 'beta-1',
            updatedAt: 2_000,
            metadata: { path: BETA_PATH, machineId: 'machine-1', name: 'Beta session' }
        })
    ]
}

function storedSettings(): Record<string, unknown> {
    const raw = localStorage.getItem(GROUP_SETTINGS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
}

// Group header titles, in document order (recency-sorted by default:
// beta updated later, so beta renders above alpha).
function groupTitles(): (string | null)[] {
    const headers = document.querySelectorAll(
        '[data-session-scroll-anchor] span.font-medium.truncate'
    )
    return Array.from(headers).map(el => el.textContent)
}

// The sticky group header row (session rows share the scroll-anchor marker,
// so key off the header's sticky wrapper directly).
function groupHeaderRow(index: number): HTMLElement {
    const rows = document.querySelectorAll('[data-session-scroll-anchor] > .sticky')
    expect(rows.length).toBeGreaterThan(index)
    return rows[index] as HTMLElement
}

function openGroupMenu(index: number) {
    fireEvent.click(screen.getAllByTestId('group-menu-button')[index])
    return {
        pin: () => fireEvent.click(screen.getByTestId('group-menu-item-pin')),
        rename: () => fireEvent.click(screen.getByTestId('group-menu-item-rename')),
    }
}

beforeEach(() => {
    localStorage.clear()
})

describe('SessionList group settings', () => {
    it('shows no group menu for the Other catch-all group', () => {
        // Sessions with no metadata land in the directory 'Other' catch-all;
        // an explicit 'Other' path exercises the same header guard.
        renderSessionList([
            makeSession({
                id: 'other-1',
                updatedAt: 1_000,
                metadata: { path: 'Other', name: 'Loose session' }
            })
        ])
        expect(screen.getByText('Other')).toBeTruthy()
        expect(screen.queryByTestId('group-menu-button')).toBeNull()
    })

    it('pins a group to the top from the menu and persists it', () => {
        renderSessionList(makeGroupSessions())
        expect(groupTitles()).toEqual(['work/beta', 'work/alpha'])

        openGroupMenu(1).pin()

        expect(groupTitles()).toEqual(['work/alpha', 'work/beta'])
        expect(storedSettings()).toEqual({ [ALPHA_KEY]: { pinned: true } })
    })

    it('unpins the group again and cleans the entry', () => {
        renderSessionList(makeGroupSessions())
        openGroupMenu(1).pin()
        openGroupMenu(0).pin()

        expect(groupTitles()).toEqual(['work/beta', 'work/alpha'])
        expect(storedSettings()).toEqual({})
    })

    it('applies persisted pin state on mount', () => {
        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, JSON.stringify({
            [ALPHA_KEY]: { pinned: true }
        }))
        renderSessionList(makeGroupSessions())
        expect(groupTitles()).toEqual(['work/alpha', 'work/beta'])
    })

    it('renames a group through the menu dialog and persists the name', () => {
        renderSessionList(makeGroupSessions())

        openGroupMenu(0).rename()
        const dialog = screen.getByRole('dialog')
        fireEvent.change(within(dialog).getByTestId('rename-group-input'), {
            target: { value: 'Beta project' }
        })
        fireEvent.click(within(dialog).getByTestId('rename-group-save'))

        expect(groupTitles()).toEqual(['Beta project', 'work/alpha'])
        expect(storedSettings()).toEqual({ [BETA_KEY]: { name: 'Beta project' } })
    })

    it('clearing the rename field resets the default display name', () => {
        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, JSON.stringify({
            [BETA_KEY]: { name: 'Old name' }
        }))
        renderSessionList(makeGroupSessions())
        expect(groupTitles()).toEqual(['Old name', 'work/alpha'])

        openGroupMenu(0).rename()
        const dialog = screen.getByRole('dialog')
        fireEvent.change(within(dialog).getByTestId('rename-group-input'), {
            target: { value: '' }
        })
        fireEvent.click(within(dialog).getByTestId('rename-group-save'))

        expect(groupTitles()).toEqual(['work/beta', 'work/alpha'])
        expect(storedSettings()).toEqual({})
    })

    it('unpinning keeps a renamed group intact', () => {
        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, JSON.stringify({
            [ALPHA_KEY]: { pinned: true, name: 'Kept name' }
        }))
        renderSessionList(makeGroupSessions())
        expect(groupTitles()).toEqual(['Kept name', 'work/beta'])

        openGroupMenu(0).pin()

        expect(groupTitles()).toEqual(['work/beta', 'Kept name'])
        expect(storedSettings()).toEqual({ [ALPHA_KEY]: { name: 'Kept name' } })
    })

    it('opens the menu from a long-press on the group header', () => {
        vi.useFakeTimers()
        try {
            renderSessionList(makeGroupSessions())
            // alpha renders second by recency
            fireEvent.touchStart(groupHeaderRow(1), { touches: [{ clientX: 50, clientY: 60 }] })
            act(() => {
                vi.advanceTimersByTime(500)
            })
            expect(screen.getByTestId('group-menu-item-pin')).toBeTruthy()

            fireEvent.click(screen.getByTestId('group-menu-item-pin'))
            expect(groupTitles()).toEqual(['work/alpha', 'work/beta'])
            expect(storedSettings()).toEqual({ [ALPHA_KEY]: { pinned: true } })
        } finally {
            vi.useRealTimers()
        }
    })
})
