import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast, type Toast } from '@/lib/toast-context'
import * as sessionActions from '@/hooks/mutations/useSessionActions'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true, thinking: false, activeAt: 0, updatedAt: Date.now(), metadata: { path: '/work/app', name: `Title ${overrides.id}` },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
        attachedJob: null, attachedJobUpdatedAt: 0,
        ...overrides
    }
}

let toasts: Toast[] = []
function ToastProbe() {
    toasts = useToast().toasts
    return null
}

function renderList(sessions: SessionSummary[], api: Partial<ApiClient>) {
    toasts = []
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
            <ToastProvider>
                <I18nProvider>
                    <ToastProbe />
                    <SessionList sessions={sessions} selectedSessionId={null} onSelect={vi.fn()}
                        onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} renderHeader={false}
                        api={api as ApiClient} />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

function renderUpdatableRow(session: SessionSummary) {
    const client = new QueryClient()
    const callbacks = { onSelect: vi.fn(), onNewSession: vi.fn(), onRefresh: vi.fn() }
    let updateRow!: (row: SessionSummary) => void
    function List() {
        const [row, setRow] = useState(session)
        updateRow = setRow
        return <SessionList sessions={[row]} selectedSessionId={null} {...callbacks}
            isLoading={false} renderHeader={false} api={null} />
    }
    render(
        <QueryClientProvider client={client}>
            <ToastProvider>
                <I18nProvider>
                    <List />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    return (row: SessionSummary) => act(() => updateRow(row))
}

describe('session row render isolation', () => {
    it('keeps a row memoized when only the attached job watermark changes', () => {
        const actions = vi.spyOn(sessionActions, 'useSessionActions')
        const session = makeSession({ id: 'idle', attachedJobUpdatedAt: 10 })
        const updateRow = renderUpdatableRow(session)
        expect(actions).toHaveBeenCalled()
        actions.mockClear()

        updateRow({ ...session, attachedJobUpdatedAt: 20 })
        expect(actions).not.toHaveBeenCalled()
        updateRow({ ...session, attachedJobUpdatedAt: 5 })
        expect(actions).not.toHaveBeenCalled()
    })

    it('repaints the title, unread indicator, and pin control on row updates', () => {
        const session = makeSession({ id: 'idle', contentRevision: 0 })
        const updateRow = renderUpdatableRow(session)
        const row = screen.getByText('Title idle').closest<HTMLElement>('[data-session-row-id]')!
        const inRow = within(row)
        expect(inRow.queryByTestId('session-unread')).toBeNull()
        expect(inRow.queryByRole('button', { name: 'Unpin' })).toBeNull()

        const renamed = { ...session, metadata: { path: '/work/app', name: 'Renamed session' } }
        updateRow(renamed)
        expect(inRow.getByText('Renamed session')).toBeInTheDocument()
        expect(inRow.queryByText('Title idle')).toBeNull()

        const unread = { ...renamed, contentRevision: 1 }
        updateRow(unread)
        expect(inRow.getByTestId('session-unread')).toBeInTheDocument()

        updateRow({ ...unread, pinned: true })
        expect(inRow.getByRole('button', { name: 'Unpin' })).toBeInTheDocument()
    })

    it('repaints the attached job when its value changes at the same watermark', () => {
        const session = makeSession({ id: 'idle' })
        const updateRow = renderUpdatableRow(session)
        const now = Date.now()
        updateRow({
            ...session,
            attachedJob: {
                key: 'import',
                label: 'Import progress',
                status: 'running',
                remaining: 1,
                total: 2,
                unit: 'items',
                heartbeatAt: now,
                startedAt: now,
                updatedAt: now,
            },
        })
        expect(screen.getByText('Import progress')).toBeInTheDocument()
    })

    it('leaves another row memoized when archive shows its toast', async () => {
        const actions = vi.spyOn(sessionActions, 'useSessionActions')
        const archiveSession = vi.fn(async () => {})
        renderList([makeSession({ id: 'target' }), makeSession({ id: 'other' })], { archiveSession })
        actions.mockClear()

        const targetRow = screen.getByText('Title target').closest<HTMLElement>('[data-session-row-id]')!
        fireEvent.click(within(targetRow).getByRole('button', { name: 'Archive' }))
        await waitFor(() => expect(toasts.map(toast => toast.title)).toEqual(['Session archived']))
        expect(actions.mock.calls.some(([, id]) => id === 'other')).toBe(false)
    })
})

describe('session row hover archive', () => {
    it('archives an idle session in one click and offers Reopen in the toast', async () => {
        const archiveSession = vi.fn(async () => {})
        const reopenSession = vi.fn(async () => ({ ok: true as const, sessionId: 'idle', resumed: true }))
        renderList([makeSession({ id: 'idle' })], { archiveSession, reopenSession } as Partial<ApiClient>)

        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        await waitFor(() => expect(archiveSession).toHaveBeenCalledWith('idle'))
        expect(screen.queryByRole('dialog')).toBeNull()
        await waitFor(() => expect(toasts.map(toast => toast.title)).toEqual(['Session archived']))
        expect(toasts[0]?.action?.label).toBe('Reopen')

        await act(async () => toasts[0]?.action?.onClick())
        await waitFor(() => expect(reopenSession).toHaveBeenCalledWith('idle'))
    })

    it.each([
        ['replying', { thinking: true }],
        ['waiting on approval', { pendingRequestsCount: 1 }],
        ['running background work', { backgroundTaskCount: 2 }]
    ])('hides Archive while the session is %s (#2020 — stop the turn first)', (_label, overrides) => {
        const archiveSession = vi.fn(async () => {})
        renderList([makeSession({ id: 'busy', ...overrides })], { archiveSession } as Partial<ApiClient>)

        expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
        expect(archiveSession).not.toHaveBeenCalled()
    })

    it('reports a failed archive in a toast', async () => {
        const archiveSession = vi.fn(async () => { throw new Error('runner offline') })
        renderList([makeSession({ id: 'idle' })], { archiveSession } as Partial<ApiClient>)

        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        await waitFor(() => expect(toasts.map(toast => [toast.title, toast.body])).toEqual([
            ['Archive could not be confirmed', 'runner offline']
        ]))
    })

    it('offers no hover archive for sessions that are already disconnected', () => {
        renderList([makeSession({ id: 'closed', active: false })], {})
        expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    })
})

it('keeps delete confirmation after clearing the meter removes its row from Active', async () => {
    localStorage.setItem('hapi-session-list-status', 'active')
    try {
        const job = { key: 'batch', label: 'Batch', runId: 'original', status: 'running' as const,
            startedAt: 1, updatedAt: 1, heartbeatAt: 1 }
        const initial = makeSession({ id: 'stale', active: false, attachedJob: job })
        const remove = vi.fn(async () => {}).mockRejectedValueOnce(new ApiError('conflict', 409,
            'attached_job_running', JSON.stringify({ job, canClearStale: true })))
        function List() {
            const [row, setRow] = useState(initial)
            const api = { deleteSession: remove, clearStaleSessionJob: async () => setRow({ ...row, attachedJob: null }) } as unknown as ApiClient
            return <SessionList sessions={[row]} selectedSessionId={null} onSelect={vi.fn()} onNewSession={vi.fn()}
                onRefresh={vi.fn()} isLoading={false} api={api} />
        }
        render(<QueryClientProvider client={new QueryClient()}><ToastProvider><I18nProvider><List /></I18nProvider></ToastProvider></QueryClientProvider>)
        fireEvent.click(screen.getByTitle('/work/app'))
        fireEvent.contextMenu(screen.getByRole('button', { name: /Title stale/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Remove stale job record' }))
        const confirm = await screen.findByRole('button', { name: 'Delete' })
        expect(screen.queryByRole('button', { name: /Title stale/ })).toBeNull()
        expect(remove).toHaveBeenCalledTimes(1)
        fireEvent.click(confirm)
        await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
    } finally { localStorage.removeItem('hapi-session-list-status') }
})

describe('session row hover archive progress', () => {
    it('keeps the spinner until the archive settles, even after the row turns inactive', async () => {
        let finishArchive: () => void = () => {}
        const archiveSession = vi.fn(() => new Promise<void>((resolve) => { finishArchive = resolve }))
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const list = (session: SessionSummary) => (
            <QueryClientProvider client={client}>
                <ToastProvider>
                    <I18nProvider>
                        <ToastProbe />
                        <SessionList sessions={[session]} selectedSessionId={null} onSelect={vi.fn()}
                            onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} renderHeader={false}
                            api={{ archiveSession } as Partial<ApiClient> as ApiClient} />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
        toasts = []
        const { rerender } = render(list(makeSession({ id: 'idle' })))

        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        await waitFor(() => expect(archiveSession).toHaveBeenCalled())
        // The hub reports the session inactive before cleanup is confirmed.
        rerender(list(makeSession({ id: 'idle', active: false })))
        expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()

        await act(async () => finishArchive())
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull())
        expect(toasts.map(toast => toast.title)).toEqual(['Session archived'])
    })

    it('keeps the spinner when the archived row moves out of the Active section', async () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        try {
            let finishArchive: () => void = () => {}
            const archiveSession = vi.fn(() => new Promise<void>((resolve) => { finishArchive = resolve }))
            const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
            const list = (session: SessionSummary) => (
                <QueryClientProvider client={client}>
                    <ToastProvider>
                        <I18nProvider>
                            <ToastProbe />
                            <SessionList sessions={[session]} selectedSessionId="idle" onSelect={vi.fn()}
                                onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} renderHeader={false}
                                api={{ archiveSession } as Partial<ApiClient> as ApiClient} />
                        </I18nProvider>
                    </ToastProvider>
                </QueryClientProvider>
            )
            toasts = []
            const { rerender } = render(list(makeSession({ id: 'idle' })))

            fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
            await waitFor(() => expect(archiveSession).toHaveBeenCalled())
            // Inactive moves the row from the pinned Active section into its
            // project group (kept open because the session is selected), which
            // mounts a fresh row component.
            rerender(list(makeSession({ id: 'idle', active: false })))
            expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()

            await act(async () => finishArchive())
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull())
            expect(toasts.map(toast => toast.title)).toEqual(['Session archived'])
        } finally {
            localStorage.removeItem('hapi-pin-in-progress-sessions')
        }
    })
})
