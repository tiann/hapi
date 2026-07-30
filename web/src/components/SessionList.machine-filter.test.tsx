import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
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

        expect(screen.queryByRole('group', { name: 'Filter sessions by machine' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Filter sessions by machine' })).toBeNull()
        expect(screen.getByTitle('/work/hapi')).toBeTruthy()
    })

    it('shows the filter bar and machine-suffixed group titles with multiple machines', () => {
        renderSessionList(multiMachineSessions)

        expect(screen.getByRole('group', { name: 'Filter sessions by machine' })).toBeTruthy()
        // Mobile (below md) counterpart: a compact filter icon button in the header
        expect(screen.getByRole('button', { name: 'Filter sessions by machine' })).toBeTruthy()
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

        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        fireEvent.change(screen.getByPlaceholderText('Search sessions…'), { target: { value: 'alpha' } })
        fireEvent.click(screen.getByRole('button', { name: /Teemo \(1\)/ }))

        expect(screen.getByText('No sessions match your filters.')).toBeTruthy()
        expect(screen.queryByTitle('/work/hapi')).toBeNull()
        expect(screen.queryByTitle('/work/docs')).toBeNull()
    })
})
