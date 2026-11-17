import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { markSessionSeen } from '@/lib/sessionLastSeen'
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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        contentRevision: overrides.updatedAt ?? 0,
        ...overrides
    }
}

function renderList(sessions: SessionSummary[], selectedSessionId: string | null = null) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider
            client={new QueryClient({
                defaultOptions: {
                    queries: { retry: false },
                    mutations: { retry: false }
                }
            })}
        >
            <ToastProvider>
                <I18nProvider>{children}</I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )

    return render(
        <SessionList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelect={vi.fn()}
            onNewSession={vi.fn()}
            onRefresh={vi.fn()}
            isLoading={false}
            renderHeader
            api={null}
        />,
        { wrapper }
    )
}

describe('SessionList lineage grouping and attention folding', () => {
    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem('hapi-pin-in-progress-sessions', 'off')
    })

    it('folds completed read child sessions under their parent until expanded', () => {
        markSessionSeen('parent', 500)
        markSessionSeen('child-1', 400)
        markSessionSeen('child-2', 300)

        renderList([
            makeSession({
                id: 'parent',
                active: true,
                updatedAt: 500,
                metadata: { path: '/work/proj', name: 'Coordinator' }
            }),
            makeSession({
                id: 'child-1',
                active: false,
                updatedAt: 400,
                metadata: {
                    path: '/work/proj',
                    name: 'Worker Alpha',
                    parentLink: { parentSessionId: 'parent', kind: 'peer' }
                }
            }),
            makeSession({
                id: 'child-2',
                active: false,
                updatedAt: 300,
                metadata: {
                    path: '/work/proj',
                    name: 'Branch Beta',
                    parentLink: { parentSessionId: 'parent', kind: 'branch' }
                }
            })
        ])

        expect(screen.getByRole('button', { name: /Coordinator/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Worker Alpha/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Branch Beta/ })).toBeNull()

        const toggle = screen.getByTestId('session-lineage-toggle')
        expect(toggle).toHaveTextContent('2 linked')
        fireEvent.click(toggle)

        expect(screen.getByRole('button', { name: /Worker Alpha/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Branch Beta/ })).toBeInTheDocument()
        expect(screen.getAllByTestId('session-lineage-kind').map((el) => el.textContent)).toEqual(['peer', 'branch'])
    })

    it('auto-expands the child group when a child session is actively running', () => {
        markSessionSeen('parent', 500)
        markSessionSeen('child-running', 450)

        renderList([
            makeSession({
                id: 'parent',
                active: true,
                updatedAt: 500,
                metadata: { path: '/work/proj', name: 'Coordinator' }
            }),
            makeSession({
                id: 'child-running',
                active: true,
                thinking: true,
                updatedAt: 450,
                metadata: {
                    path: '/work/proj',
                    name: 'Live Worker',
                    parentLink: { parentSessionId: 'parent', kind: 'peer' }
                }
            })
        ])

        expect(screen.getByTestId('session-lineage-toggle')).toHaveTextContent('1 linked · 1 running')
        expect(screen.getByRole('button', { name: /Live Worker/ })).toBeInTheDocument()
    })

    it('shows parent title label on cross-directory child rows', () => {
        markSessionSeen('parent', 500)
        markSessionSeen('child-other', 450)

        renderList([
            makeSession({
                id: 'parent',
                active: true,
                updatedAt: 500,
                metadata: { path: '/work/repo-a', name: 'Lead Repo A' }
            }),
            makeSession({
                id: 'child-other',
                active: true,
                updatedAt: 450,
                metadata: {
                    path: '/work/repo-b',
                    name: 'Cross Repo Worker',
                    parentLink: { parentSessionId: 'parent', kind: 'peer' }
                }
            })
        ])

        expect(screen.getByText('↳ Lead Repo A')).toBeInTheDocument()
    })
})
