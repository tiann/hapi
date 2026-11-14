import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { en, ru, zhCN } from '@/lib/locales'
import { markSessionSeen } from '@/lib/sessionLastSeen'
import { ToastProvider, useToast, type Toast } from '@/lib/toast-context'
import { DEFAULT_SESSION_PREVIEW_LIMIT } from '@/hooks/useSessionPreviewLimit'
import { SessionList } from './SessionList'

beforeEach(() => {
    localStorage.clear()
})

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
        contentRevision: overrides.updatedAt ?? 0,
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

    it('expands a collapsed destination project and preserves focus when keyboard-unpinning an unselected read inactive global pin', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        markSessionSeen('global-pin', 1000)
        markSessionSeen('quiet-old', 900)
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const { rerenderSessions } = renderList(
            [
                makeSession({
                    id: 'global-pin',
                    active: false,
                    globalPinned: true,
                    updatedAt: 1000,
                    metadata: { path: '/work/quiet', name: 'Title global-pin' },
                }),
                makeSession({
                    id: 'quiet-old',
                    active: false,
                    updatedAt: 900,
                    metadata: { path: '/work/quiet', name: 'Quiet old' },
                }),
            ],
            { setSessionPinMode },
            { client }
        )

        expect(screen.queryByRole('button', { name: /Quiet old/ })).toBeNull()

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        fireEvent.click(unpinButton)
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('global-pin', 'none'))

        await act(async () => finishUnpin())
        rerenderSessions([
            makeSession({
                id: 'global-pin',
                active: false,
                globalPinned: false,
                updatedAt: 1000,
                metadata: { path: '/work/quiet', name: 'Title global-pin' },
            }),
            makeSession({
                id: 'quiet-old',
                active: false,
                updatedAt: 900,
                metadata: { path: '/work/quiet', name: 'Quiet old' },
            }),
        ])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        const movedRowButton = screen.getByRole('button', { name: /Title global-pin/ })
        expect(document.activeElement).toBe(movedRowButton)
    })

    it('reveals a destination row past the preview limit and preserves focus on keyboard unpin', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        const newerSessions = Array.from({ length: DEFAULT_SESSION_PREVIEW_LIMIT + 1 }, (_, i) => {
            const updatedAt = 2000 + i
            markSessionSeen(`busy-${i}`, updatedAt)
            return makeSession({
                id: `busy-${i}`,
                active: i === 0,
                updatedAt,
                metadata: { path: '/work/quiet', name: `Busy ${i}` },
            })
        })
        markSessionSeen('global-pin', 1000)
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const { rerenderSessions } = renderList(
            [
                makeSession({
                    id: 'global-pin',
                    active: false,
                    globalPinned: true,
                    updatedAt: 1000,
                    metadata: { path: '/work/quiet', name: 'Title global-pin' },
                }),
                ...newerSessions,
            ],
            { setSessionPinMode },
            { client }
        )

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        fireEvent.click(unpinButton)
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('global-pin', 'none'))

        await act(async () => finishUnpin())
        rerenderSessions([
            makeSession({
                id: 'global-pin',
                active: false,
                globalPinned: false,
                updatedAt: 1000,
                metadata: { path: '/work/quiet', name: 'Title global-pin' },
            }),
            ...newerSessions,
        ])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        const movedRowButton = screen.getByRole('button', { name: /Title global-pin/ })
        expect(document.activeElement).toBe(movedRowButton)
    })

    it('keeps a project group open when keyboard-unpinning its sole unselected read inactive project pin', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        markSessionSeen('project-pin', 1000)
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const { rerenderSessions } = renderList(
            [
                makeSession({
                    id: 'project-pin',
                    active: false,
                    pinned: true,
                    updatedAt: 1000,
                    metadata: { path: '/work/quiet', name: 'Title project-pin' },
                }),
            ],
            { setSessionPinMode },
            { client }
        )

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        fireEvent.click(unpinButton)
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('project-pin', 'none'))

        await act(async () => finishUnpin())
        rerenderSessions([
            makeSession({
                id: 'project-pin',
                active: false,
                pinned: false,
                updatedAt: 1000,
                metadata: { path: '/work/quiet', name: 'Title project-pin' },
            }),
        ])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        expect(screen.getByTitle('/work/quiet')).toHaveAttribute('aria-expanded', 'true')
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Title project-pin/ }))
    })

    it('moves focus to a visible fallback instead of document.body if the unpinned row disappears from the list', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        const { rerenderSessions } = renderList(
            [
                makeSession({
                    id: 'stub-pin',
                    active: false,
                    globalPinned: true,
                    hasConversationContent: false,
                    metadata: { path: '/work/quiet' },
                }),
                makeSession({
                    id: 'other',
                    active: true,
                    metadata: { path: '/work/other', name: 'Other session' },
                }),
            ],
            { setSessionPinMode },
            { client }
        )

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        fireEvent.click(unpinButton)
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('stub-pin', 'none'))

        await act(async () => finishUnpin())
        rerenderSessions([
            makeSession({
                id: 'stub-pin',
                active: false,
                globalPinned: false,
                hasConversationContent: false,
                metadata: { path: '/work/quiet' },
            }),
            makeSession({
                id: 'other',
                active: true,
                metadata: { path: '/work/other', name: 'Other session' },
            }),
        ])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        expect(document.activeElement).not.toBe(document.body)
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Other session/ }))
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

    it('marks each row with its visible quick-action count and summary header/trailing hooks', () => {
        renderList(
            [
                makeSession({ id: 'active-pinned', active: true, pinned: true }),
                makeSession({ id: 'inactive-pinned', active: false, pinned: true }),
                makeSession({ id: 'active-unpinned', active: true, pinned: false }),
                makeSession({ id: 'inactive-unpinned', active: false, pinned: false }),
            ],
            {}
        )

        const rowFor = (id: string) => document.querySelector(`[data-session-row-id="${id}"]`)
        expect(rowFor('active-pinned')).toHaveAttribute('data-quick-action-count', '2')
        expect(rowFor('inactive-pinned')).toHaveAttribute('data-quick-action-count', '1')
        expect(rowFor('active-unpinned')).toHaveAttribute('data-quick-action-count', '1')
        expect(rowFor('inactive-unpinned')).not.toHaveAttribute('data-quick-action-count')

        expect(rowFor('active-pinned')?.querySelector('.session-row-header')).not.toBeNull()
        expect(rowFor('active-pinned')?.querySelector('.session-row-trailing')).not.toBeNull()
    })
})
