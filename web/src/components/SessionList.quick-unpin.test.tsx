import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { en, ru, zhCN } from '@/lib/locales'
import { ToastProvider, useToast, type Toast } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(cleanup)

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: Date.now(),
        metadata: { path: '/work/app', name: `Title ${overrides.id}` },
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
        ...overrides,
    }
}

let toasts: Toast[] = []
function ToastProbe() {
    toasts = useToast().toasts
    return null
}

function renderList(
    sessions: SessionSummary[],
    api: Partial<ApiClient>,
    options: { client?: QueryClient; selectedSessionId?: string | null } = {}
) {
    toasts = []
    const client = options.client ?? new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const renderTree = (nextSessions: SessionSummary[]) => (
        <QueryClientProvider client={client}>
            <ToastProvider>
                <I18nProvider>
                    <ToastProbe />
                    <SessionList
                        sessions={nextSessions}
                        selectedSessionId={options.selectedSessionId ?? null}
                        onSelect={vi.fn()}
                        onNewSession={vi.fn()}
                        onRefresh={vi.fn()}
                        isLoading={false}
                        renderHeader={false}
                        api={api as ApiClient}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    const view = render(renderTree(sessions))
    return {
        ...view,
        rerenderSessions: (nextSessions: SessionSummary[]) => view.rerender(renderTree(nextSessions)),
    }
}

describe('session row hover unpin', () => {
    it.each([
        ['project-pinned', { pinned: true }],
        ['globally-pinned', { globalPinned: true }],
    ])('shows Unpin for a %s row and calls setSessionPinMode with none', async (_label, overrides) => {
        const setSessionPinMode = vi.fn(async () => {})
        renderList(
            [makeSession({ id: 'pinned-row', ...overrides })],
            { setSessionPinMode }
        )

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()

        fireEvent.click(unpinButton)
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('pinned-row', 'none'))
    })

    it('shows Unpin for an inactive pinned row (without Archive)', () => {
        renderList(
            [makeSession({ id: 'inactive-pinned', active: false, pinned: true })],
            {}
        )

        expect(screen.getByRole('button', { name: 'Unpin' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    })

    it('shows no Unpin button for unpinned rows', () => {
        renderList(
            [
                makeSession({ id: 'active-unpinned', active: true }),
                makeSession({ id: 'inactive-unpinned', active: false }),
            ],
            {}
        )

        expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull()
    })

    it('disables the Unpin button while pending and keeps the spinner when moving out of the pinned section', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const { rerenderSessions } = renderList(
            [makeSession({ id: 'global-pin', active: false, globalPinned: true })],
            { setSessionPinMode },
            { client, selectedSessionId: 'global-pin' }
        )

        fireEvent.click(screen.getByRole('button', { name: 'Unpin' }))
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('global-pin', 'none'))

        const pendingButton = screen.getByRole('button', { name: 'Unpin' })
        expect(pendingButton).toBeDisabled()
        expect(pendingButton.closest('.session-list-row')).toHaveAttribute('data-quick-action-pending', '')

        // Clearing globalPinned moves the row from the pinned section into its
        // project group (kept open because it is selected), mounting a fresh row.
        rerenderSessions([makeSession({ id: 'global-pin', active: false, globalPinned: false })])
        const remountedPendingButton = screen.getByRole('button', { name: 'Unpin' })
        expect(remountedPendingButton).toBeDisabled()
        expect(remountedPendingButton.closest('.session-list-row')).toHaveAttribute('data-quick-action-pending', '')

        await act(async () => finishUnpin())
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
    })

    it('preserves focus on the row when unpinning moves it out of the pinned section', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const { rerenderSessions } = renderList(
            [
                makeSession({ id: 'global-pin', active: true, globalPinned: true }),
                makeSession({ id: 'other', active: true }),
            ],
            { setSessionPinMode },
            { client }
        )

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        expect(document.activeElement).toBe(unpinButton)

        fireEvent.click(unpinButton)
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('global-pin', 'none'))

        await act(async () => finishUnpin())
        rerenderSessions([
            makeSession({ id: 'global-pin', active: true, globalPinned: false }),
            makeSession({ id: 'other', active: true }),
        ])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        const movedRowButton = screen.getByRole('button', { name: /Title global-pin/ })
        expect(document.activeElement).toBe(movedRowButton)
    })

    it('preserves focus and spinner when a row remounts out of the pinned section while still pending', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const { rerenderSessions } = renderList(
            [
                makeSession({ id: 'global-pin', active: true, globalPinned: true }),
                makeSession({ id: 'other', active: true }),
            ],
            { setSessionPinMode },
            { client }
        )

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        fireEvent.click(unpinButton)
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('global-pin', 'none'))

        rerenderSessions([
            makeSession({ id: 'global-pin', active: true, globalPinned: false }),
            makeSession({ id: 'other', active: true }),
        ])
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Title global-pin/ }))
        expect(screen.getByRole('button', { name: 'Unpin' })).toBeDisabled()

        await act(async () => finishUnpin())
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Title global-pin/ }))
    })

    it('reports a failed unpin in a toast', async () => {
        const setSessionPinMode = vi.fn(async () => {
            throw new Error('network down')
        })
        renderList([makeSession({ id: 'pinned-row', pinned: true })], { setSessionPinMode })

        fireEvent.click(screen.getByRole('button', { name: 'Unpin' }))
        await waitFor(() => expect(toasts.map(toast => [toast.title, toast.body])).toEqual([
            ['Could not update pin', 'network down']
        ]))
    })

    it('localizes session.action.unpin in every shipped locale', () => {
        expect(en['session.action.unpin']).toBe('Unpin')
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru]] as const) {
            expect(dict['session.action.unpin'], `${locale} should define the key`).toBeTruthy()
            expect(dict['session.action.unpin'], `${locale} should not ship the English copy`).not.toBe(en['session.action.unpin'])
        }
    })
})
