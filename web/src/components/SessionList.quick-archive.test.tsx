import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast, type Toast } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(cleanup)

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true, thinking: false, activeAt: 0, updatedAt: Date.now(), metadata: { path: '/work/app', name: `Title ${overrides.id}` },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
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
    ])('asks for confirmation before archiving a session that is %s', (_label, overrides) => {
        const archiveSession = vi.fn(async () => {})
        renderList([makeSession({ id: 'busy', ...overrides })], { archiveSession } as Partial<ApiClient>)

        fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
        expect(screen.getByText('Archive Session')).toBeInTheDocument()
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
