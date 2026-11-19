import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { DEFAULT_SESSION_PREVIEW_LIMIT } from '@/hooks/useSessionPreviewLimit'
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

function makeListNode(
    sessions: SessionSummary[],
    selectedSessionId: string | null = null,
    api: ApiClient | null = null
) {
    return (
        <SessionList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelect={vi.fn()}
            onNewSession={vi.fn()}
            onRefresh={vi.fn()}
            isLoading={false}
            renderHeader
            api={api}
        />
    )
}

function renderList(
    sessions: SessionSummary[],
    selectedSessionId: string | null = null,
    api: Partial<ApiClient> | null = null
) {
    const resolvedApi = api as ApiClient | null
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>{children}</I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )

    const view = render(makeListNode(sessions, selectedSessionId, resolvedApi), { wrapper })
    return {
        ...view,
        rerenderList: (nextSessions: SessionSummary[], nextSelectedId: string | null = selectedSessionId) => {
            view.rerender(makeListNode(nextSessions, nextSelectedId, resolvedApi))
        }
    }
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
        expect(screen.getAllByTestId('session-lineage-kind').map((el) => el.textContent)).toEqual(['branch'])
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

    it('keeps a project-pinned settled child visible above the pin divider with its parent label', () => {
        markSessionSeen('parent', 500)
        markSessionSeen('pinned-child', 400)

        renderList([
            makeSession({
                id: 'parent',
                active: true,
                updatedAt: 500,
                metadata: { path: '/work/proj', name: 'Coordinator' }
            }),
            makeSession({
                id: 'pinned-child',
                active: false,
                pinned: true,
                updatedAt: 400,
                metadata: {
                    path: '/work/proj',
                    name: 'Pinned Worker',
                    parentLink: { parentSessionId: 'parent', kind: 'peer' }
                }
            })
        ])

        const pinnedTitle = screen.getByTitle('Pinned Worker')
        const parentTitle = screen.getByTitle('Coordinator')
        const pinnedButton = pinnedTitle.closest('button')
        const parentButton = parentTitle.closest('button')
        const divider = screen.getByTestId('session-pin-divider')

        expect(pinnedButton).not.toBeNull()
        expect(parentButton).not.toBeNull()
        expect(screen.getByText('↳ Coordinator')).toBeInTheDocument()
        expect(Boolean(pinnedButton!.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
        expect(Boolean(divider.compareDocumentPosition(parentButton!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    })

    it('keeps an older parent and its running read child visible past root pagination', () => {
        const recentSessions = Array.from({ length: DEFAULT_SESSION_PREVIEW_LIMIT + 2 }, (_, idx) => {
            const id = `recent-${idx}`
            const updatedAt = 5000 - idx * 10
            markSessionSeen(id, updatedAt)
            return makeSession({
                id,
                active: idx === 0,
                updatedAt,
                metadata: { path: '/work/proj', name: `Recent ${idx}` }
            })
        })
        markSessionSeen('older-parent', 100)
        markSessionSeen('running-child', 90)

        renderList([
            ...recentSessions,
            makeSession({
                id: 'older-parent',
                active: false,
                updatedAt: 100,
                metadata: { path: '/work/proj', name: 'Older Parent' }
            }),
            makeSession({
                id: 'running-child',
                active: true,
                thinking: true,
                updatedAt: 90,
                metadata: {
                    path: '/work/proj',
                    name: 'Active Deep Worker',
                    parentLink: { parentSessionId: 'older-parent', kind: 'peer' }
                }
            })
        ])

        expect(screen.getByRole('button', { name: /Older Parent/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Active Deep Worker/ })).toBeInTheDocument()
    })

    it('peeks unread and urgent-error children after explicit lineage collapse', () => {
        markSessionSeen('parent', 500)
        markSessionSeen('child', 450)

        const parent = makeSession({
            id: 'parent',
            active: true,
            updatedAt: 500,
            metadata: { path: '/work/proj', name: 'Coordinator' }
        })
        const runningReadChild = makeSession({
            id: 'child',
            active: true,
            thinking: true,
            updatedAt: 450,
            metadata: {
                path: '/work/proj',
                name: 'Inspectable Worker',
                parentLink: { parentSessionId: 'parent', kind: 'peer' }
            }
        })

        const { rerenderList } = renderList([parent, runningReadChild])
        const panel = screen.getByTitle('Inspectable Worker').closest('.collapsible-panel')
        expect(panel?.hasAttribute('data-open')).toBe(true)

        fireEvent.click(screen.getByTestId('session-lineage-toggle'))
        expect(panel?.hasAttribute('data-open')).toBe(false)

        rerenderList([
            parent,
            makeSession({
                id: 'child',
                active: false,
                updatedAt: 600,
                contentRevision: 600,
                metadata: {
                    path: '/work/proj',
                    name: 'Inspectable Worker',
                    parentLink: { parentSessionId: 'parent', kind: 'peer' }
                }
            })
        ])
        expect(panel?.hasAttribute('data-open')).toBe(true)

        markSessionSeen('child', 700)
        rerenderList([
            parent,
            makeSession({
                id: 'child',
                active: true,
                updatedAt: 700,
                contentRevision: 700,
                metadata: {
                    path: '/work/proj',
                    name: 'Inspectable Worker',
                    parentLink: { parentSessionId: 'parent', kind: 'peer' }
                }
            })
        ])
        expect(panel?.hasAttribute('data-open')).toBe(false)

        rerenderList([
            parent,
            makeSession({
                id: 'child',
                active: true,
                updatedAt: 700,
                contentRevision: 700,
                metadata: {
                    path: '/work/proj',
                    name: 'Inspectable Worker',
                    parentLink: { parentSessionId: 'parent', kind: 'peer' },
                    lastModelError: {
                        eventId: 'err-1',
                        kind: 'rate_limit',
                        transient: true,
                        rawSnippet: '429',
                        atTs: 700,
                        priorAssistantClaimsDone: false,
                    }
                }
            })
        ])
        expect(panel?.hasAttribute('data-open')).toBe(true)
    })

    it('opens a folded lineage and restores focus when keyboard-unpinning an idle read project-pinned child', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        markSessionSeen('parent', 500)
        markSessionSeen('pinned-child', 400)

        const parent = makeSession({
            id: 'parent',
            active: true,
            updatedAt: 500,
            metadata: { path: '/work/proj', name: 'Coordinator' }
        })
        const pinnedChild = makeSession({
            id: 'pinned-child',
            active: false,
            pinned: true,
            updatedAt: 400,
            metadata: {
                path: '/work/proj',
                name: 'Pinned Worker',
                parentLink: { parentSessionId: 'parent', kind: 'peer' }
            }
        })

        const { rerenderList } = renderList([parent, pinnedChild], null, { setSessionPinMode })

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        fireEvent.click(unpinButton, { detail: 0 })
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('pinned-child', 'none'))

        await act(async () => finishUnpin())
        rerenderList([parent, { ...pinnedChild, pinned: false }])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        expect(screen.getByTestId('session-lineage-toggle')).toHaveAttribute('aria-expanded', 'true')
        const remountedChildButton = screen.getByRole('button', { name: /Pinned Worker/ })
        expect(remountedChildButton.closest('.collapsible-panel:not([data-open])')).toBeNull()
        expect(document.activeElement).toBe(remountedChildButton)
    })

    it('reveals a lineage root beyond the preview limit, opens its lineage, and restores focus on keyboard unpin', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        const recentSessions = Array.from({ length: DEFAULT_SESSION_PREVIEW_LIMIT + 1 }, (_, idx) => {
            const id = `recent-${idx}`
            const ts = 5000 - idx * 10
            markSessionSeen(id, ts)
            return makeSession({
                id,
                active: idx === 0,
                createdAt: ts,
                lastUserMessageAt: ts,
                updatedAt: ts,
                metadata: { path: '/work/proj', name: `Recent ${idx}` }
            })
        })
        markSessionSeen('older-parent', 100)
        markSessionSeen('mid-child', 95)
        markSessionSeen('global-pinned-grandchild', 4995)
        markSessionSeen('oldest-parent', 50)
        markSessionSeen('oldest-running-child', 45)

        const olderParent = makeSession({
            id: 'older-parent',
            active: false,
            createdAt: 100,
            lastUserMessageAt: 100,
            updatedAt: 100,
            metadata: { path: '/work/proj', name: 'Older Parent' }
        })
        const midChild = makeSession({
            id: 'mid-child',
            active: false,
            createdAt: 95,
            lastUserMessageAt: 95,
            updatedAt: 95,
            metadata: {
                path: '/work/proj',
                name: 'Middle Worker',
                parentLink: { parentSessionId: 'older-parent', kind: 'peer' }
            }
        })
        const globalPinnedGrandchild = makeSession({
            id: 'global-pinned-grandchild',
            active: false,
            globalPinned: true,
            createdAt: 4995,
            lastUserMessageAt: 4995,
            updatedAt: 4995,
            metadata: {
                path: '/work/proj',
                name: 'Deep Pinned Worker',
                parentLink: { parentSessionId: 'mid-child', kind: 'fork' }
            }
        })
        // A later root that stays required because of a running read child forces
        // root preview pagination to reserve an extra slot beyond older-parent.
        const oldestParent = makeSession({
            id: 'oldest-parent',
            active: false,
            createdAt: 50,
            lastUserMessageAt: 50,
            updatedAt: 50,
            metadata: { path: '/work/proj', name: 'Oldest Parent' }
        })
        const oldestRunningChild = makeSession({
            id: 'oldest-running-child',
            active: true,
            thinking: true,
            createdAt: 45,
            lastUserMessageAt: 45,
            updatedAt: 45,
            metadata: {
                path: '/work/proj',
                name: 'Oldest Live Worker',
                parentLink: { parentSessionId: 'oldest-parent', kind: 'peer' }
            }
        })

        const { rerenderList } = renderList(
            [...recentSessions, olderParent, midChild, globalPinnedGrandchild, oldestParent, oldestRunningChild],
            null,
            { setSessionPinMode }
        )

        expect(screen.queryByRole('button', { name: /Older Parent/ })).toBeNull()

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        unpinButton.focus()
        fireEvent.click(unpinButton, { detail: 0 })
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('global-pinned-grandchild', 'none'))

        await act(async () => finishUnpin())
        rerenderList([
            ...recentSessions,
            olderParent,
            midChild,
            { ...globalPinnedGrandchild, globalPinned: false },
            oldestParent,
            oldestRunningChild
        ])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        const olderParentButton = screen.getByRole('button', { name: /Older Parent/ })
        expect(olderParentButton).toBeInTheDocument()
        const olderParentLineageToggle = olderParentButton
            .closest('.collapsible-panel')
            ?.parentElement
            ?.querySelector('[data-testid="session-lineage-toggle"]')
        expect(olderParentLineageToggle).toHaveAttribute('aria-expanded', 'true')
        const remountedButton = screen.getByRole('button', { name: /Deep Pinned Worker/ })
        expect(remountedButton.closest('.collapsible-panel:not([data-open])')).toBeNull()
        expect(document.activeElement).toBe(remountedButton)
    })

    it('keeps a folded lineage closed when mouse-unpinning an idle read child', async () => {
        let finishUnpin: () => void = () => {}
        const setSessionPinMode = vi.fn(() => new Promise<void>((resolve) => {
            finishUnpin = resolve
        }))
        markSessionSeen('parent', 500)
        markSessionSeen('pinned-child', 400)

        const parent = makeSession({
            id: 'parent',
            active: true,
            updatedAt: 500,
            metadata: { path: '/work/proj', name: 'Coordinator' }
        })
        const pinnedChild = makeSession({
            id: 'pinned-child',
            active: false,
            pinned: true,
            updatedAt: 400,
            metadata: {
                path: '/work/proj',
                name: 'Pinned Worker',
                parentLink: { parentSessionId: 'parent', kind: 'peer' }
            }
        })

        const { rerenderList } = renderList([parent, pinnedChild], null, { setSessionPinMode })

        const unpinButton = screen.getByRole('button', { name: 'Unpin' })
        fireEvent.mouseDown(unpinButton)
        unpinButton.focus()
        fireEvent.click(unpinButton, { detail: 1 })
        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('pinned-child', 'none'))

        await act(async () => finishUnpin())
        rerenderList([parent, { ...pinnedChild, pinned: false }])

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull())
        expect(screen.getByTestId('session-lineage-toggle')).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('button', { name: /Pinned Worker/ })).toBeNull()
    })
})
