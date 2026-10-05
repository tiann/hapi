import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { markSessionSeen } from '@/lib/sessionLastSeen'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

/**
 * tiann/hapi#1820: a keepalive-idle session keeps `active: true` (the socket
 * really is up), so every "is it alive?" derivation in the list has to read
 * `lifecycleState` instead. These render the real component: the pure
 * bucketing helper is covered in SessionList.test.ts, but nothing there
 * proves the idle bucket is actually drawn or that the default view tells
 * idle apart from running.
 */

afterEach(() => {
    cleanup()
    localStorage.clear()
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

function renderSessionList(sessions: SessionSummary[], children?: ReactNode) {
    // The steady state: the operator has looked at these already, so no
    // unread marker outranks the lifecycle indicator.
    for (const session of sessions) markSessionSeen(session.id, session.updatedAt)
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    return render(
        <QueryClientProvider client={queryClient}>
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
                        api={null}
                    />
                    {children}
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

const zombie = makeSession({
    id: 'zombie',
    active: true,
    updatedAt: 200,
    metadata: { path: '/work/zombie', host: 'h', lifecycleState: 'idle', summary: { text: 'Zombie task' } } as SessionSummary['metadata']
})
const live = makeSession({
    id: 'live',
    active: true,
    updatedAt: 100,
    metadata: { path: '/work/live', host: 'h', lifecycleState: 'running', summary: { text: 'Live task' } } as SessionSummary['metadata']
})

describe('SessionList keepalive-idle lifecycle', () => {
    it('renders the idle bucket inside the pinned Active section', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        renderSessionList([zombie])

        // The row left its directory group for the pinned section; if that
        // section forgot the idle bucket the session would be nowhere.
        const section = screen.getByTitle('Active sessions').parentElement!
        expect(within(section).getByText('Idle (keepalive only) (1)')).toBeTruthy()
        expect(within(section).getByTitle('Zombie task')).toBeTruthy()
        // The bucket header already says "Idle (keepalive only)"; the row in
        // it carries the dot alone, not the label a second time.
        expect(within(section).getByTestId('session-row-idle').textContent).not.toContain('Idle (keepalive only)')
    })

    it('marks an idle row in the default view and ranks its group below a live one', () => {
        renderSessionList([zombie, live])

        // Not pinned: both rows sit in their directory groups, and the idle
        // one is labelled rather than dressed up as ready.
        const idleRow = screen.getByTitle('Zombie task').closest('button')!
        expect(within(idleRow).getByTestId('session-row-idle').textContent).toContain('Idle (keepalive only)')
        const liveRow = screen.getByTitle('Live task').closest('button')!
        expect(within(liveRow).queryByTestId('session-row-idle')).toBeNull()

        // Group order follows liveness, not the newer updatedAt of the zombie.
        const headers = screen.getAllByTitle(/^\/work\/(zombie|live)$/)
        expect(headers.map((header) => header.getAttribute('title'))).toEqual(['/work/live', '/work/zombie'])
        // ...and only the live group auto-expands.
        const panelOf = (header: HTMLElement) => header.parentElement!.querySelector('.collapsible-panel')!
        expect(panelOf(headers[0]).getAttribute('data-open')).toBe('true')
        expect(panelOf(headers[1]).getAttribute('data-open')).toBeNull()
    })

    it('reads an idle row that is thinking again as live, like the pinned buckets do', () => {
        // The hub keeps the idle mark through ambient thinking churn
        // (tiann/hapi#1553), and bucketRunningSessions files such a row under
        // Working. The default view has to agree: spinner, full contrast, and
        // the group ranks with the live ones instead of below them.
        renderSessionList([{ ...zombie, thinking: true }, live])

        const row = screen.getByTitle('Zombie task').closest('button')!
        expect(within(row).queryByTestId('session-row-idle')).toBeNull()
        expect(row.querySelector('.animate-spin-slow')).not.toBeNull()
        expect(screen.getByTitle('Zombie task').className).toContain('text-[var(--app-fg)]')

        const headers = screen.getAllByTitle(/^\/work\/(zombie|live)$/)
        expect(headers.map((header) => header.getAttribute('title'))).toEqual(['/work/zombie', '/work/live'])
    })
})
