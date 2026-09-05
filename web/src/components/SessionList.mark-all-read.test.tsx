import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

describe('SessionList mark all as read', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('only shows the independent action when unread sessions exist', () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ read: 1000 }))
        renderSessionList([
            makeSession({ id: 'read', updatedAt: 1000, metadata: { path: '/work/read', name: 'Read' } })
        ])

        expect(screen.queryByRole('button', { name: 'Mark all as read (1)' })).toBeNull()

        cleanup()
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ unread: 1000 }))
        renderSessionList([
            makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/unread', name: 'Unread' } })
        ])

        const action = screen.getByRole('button', { name: 'Mark all as read (1)' })
        expect(action).toBeTruthy()
        expect(action).toHaveClass('text-[var(--app-hint)]', 'hover:text-[var(--app-fg)]')
        expect(action.textContent).toBe('')
        expect(action.querySelector('svg')).toBeTruthy()
    })

    it('requires confirmation before marking every unread session read', async () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({
            unreadA: 1000,
            unreadB: 2000,
            read: 3000
        }))
        renderSessionList([
            makeSession({ id: 'unreadA', updatedAt: 1100, metadata: { path: '/work/a', name: 'Unread A' } }),
            makeSession({ id: 'unreadB', updatedAt: 2200, metadata: { path: '/work/b', name: 'Unread B' } }),
            makeSession({ id: 'read', updatedAt: 3000, metadata: { path: '/work/read', name: 'Read' } })
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Mark all as read (2)' }))
        const dialog = screen.getByRole('dialog')
        const title = within(dialog).getByRole('heading', { name: 'Mark all as read?' })
        expect(title.parentElement).toHaveClass('pr-0')
        expect(title).toHaveClass('min-h-6', 'px-10', 'text-center', 'leading-6')
        expect(screen.getByText('This will mark 2 unread sessions as read on this device.')).toBeTruthy()
        expect(within(dialog).getByRole('button', { name: 'Confirm' })).toHaveClass('bg-red-600', 'text-white')
        expect(JSON.parse(localStorage.getItem('hapi.sessionLastSeen.v1')!)).toMatchObject({ unreadA: 1000, unreadB: 2000 })

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

        await waitFor(() => {
            expect(screen.queryByRole('button', { name: 'Mark all as read (2)' })).toBeNull()
        })
        expect(JSON.parse(localStorage.getItem('hapi.sessionLastSeen.v1')!)).toMatchObject({
            unreadA: 1100,
            unreadB: 2200,
            read: 3000
        })
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('leaves unread state unchanged when the confirmation is cancelled', () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ unread: 1000 }))
        renderSessionList([
            makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/unread', name: 'Unread' } })
        ])

        fireEvent.click(screen.getByRole('button', { name: 'Mark all as read (1)' }))
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(screen.getByRole('button', { name: 'Mark all as read (1)' })).toBeTruthy()
        expect(JSON.parse(localStorage.getItem('hapi.sessionLastSeen.v1')!)).toEqual({ unread: 1000 })
    })

    it('marks hidden duplicate session IDs so a dedup winner change stays read', async () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({
            visibleWinner: 2000,
            hiddenDuplicate: 0,
        }))
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false },
            }
        })
        const renderTree = (sessions: SessionSummary[]) => (
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
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
        const initialSessions = [
            makeSession({
                id: 'visibleWinner',
                updatedAt: 2000,
                metadata: { path: '/work/shared', name: 'Visible winner', agentSessionId: 'native-1', flavor: 'codex' }
            }),
            makeSession({
                id: 'hiddenDuplicate',
                updatedAt: 1000,
                metadata: { path: '/work/shared', name: 'Hidden duplicate', agentSessionId: 'native-1', flavor: 'codex' }
            }),
        ]
        const view = render(renderTree(initialSessions))

        fireEvent.click(screen.getByRole('button', { name: 'Mark all as read (1)' }))
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
        await waitFor(() => {
            expect(screen.queryByRole('button', { name: 'Mark all as read (1)' })).toBeNull()
        })

        view.rerender(renderTree(initialSessions.map(session => (
            session.id === 'hiddenDuplicate' ? { ...session, active: true } : session
        ))))

        expect(screen.queryByRole('button', { name: 'Mark all as read (1)' })).toBeNull()
        expect(JSON.parse(localStorage.getItem('hapi.sessionLastSeen.v1')!)).toMatchObject({
            visibleWinner: 2000,
            hiddenDuplicate: 1000,
        })
    })

    it('does not count unread inactive empty session stubs', () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({
            visible: 2000,
            emptyStub: 0,
        }))
        renderSessionList([
            makeSession({
                id: 'visible',
                updatedAt: 2000,
                metadata: { path: '/work/visible', name: 'Visible' }
            }),
            makeSession({ id: 'emptyStub', updatedAt: 3000 })
        ])

        expect(screen.queryByRole('button', { name: 'Mark all as read (1)' })).toBeNull()
    })

    it('uses the requested Chinese label', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ unread: 1000 }))
        renderSessionList([
            makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/unread', name: 'Unread' } })
        ])

        expect(screen.getByRole('button', { name: '全部标为已读（1）' })).toBeTruthy()
    })
})
