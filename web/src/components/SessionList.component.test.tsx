import type { ComponentProps, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionList } from './SessionList'

type SessionListProps = ComponentProps<typeof SessionList>

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    const { id, ...rest } = overrides
    const baseMetadata = {
        path: '/repo',
        name: id
    }
    const base: SessionSummary = {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: baseMetadata,
        todoProgress: null,
        pendingRequestsCount: 0
    }

    const metadata: SessionSummary['metadata'] = {
        ...baseMetadata,
        ...(rest.metadata ?? {}),
        path: rest.metadata?.path ?? baseMetadata.path
    }

    return {
        ...base,
        ...rest,
        metadata
    }
}

function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })
}

function TestProviders(props: {
    queryClient: QueryClient
    children: ReactNode
}) {
    return (
        <QueryClientProvider client={props.queryClient}>
            <I18nProvider>
                {props.children}
            </I18nProvider>
        </QueryClientProvider>
    )
}

function renderSessionList(props: SessionListProps) {
    const queryClient = createQueryClient()

    const renderTree = (nextProps: SessionListProps) => (
        <TestProviders queryClient={queryClient}>
            <SessionList {...nextProps} />
        </TestProviders>
    )

    const rendered = render(renderTree(props))

    return {
        ...rendered,
        rerenderSessionList: (nextProps: SessionListProps) => {
            rendered.rerender(renderTree(nextProps))
        }
    }
}

function buildProps(overrides: Partial<SessionListProps> = {}): SessionListProps {
    return {
        sessions: [],
        onSelect: vi.fn(),
        onNewSession: vi.fn(),
        onRefresh: vi.fn(),
        isLoading: false,
        renderHeader: false,
        api: null,
        selectedSessionId: null,
        ...overrides
    }
}

function getRenderedSessionOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'))
        .map((element) => element.dataset.sessionId ?? '')
}

function getSelectionModeButton(container: HTMLElement): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    const selectButton = buttons.find(button => button.textContent?.trim() === 'Select')
    if (!selectButton) {
        throw new Error('Select button not found')
    }
    return selectButton
}

function getSessionMainButton(container: HTMLElement, sessionId: string): HTMLButtonElement {
    const sessionRow = container.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`)
    if (!sessionRow) {
        throw new Error(`Session row not found: ${sessionId}`)
    }
    const buttons = sessionRow.querySelectorAll<HTMLButtonElement>('button')
    const mainButton = buttons[buttons.length - 1]
    if (!mainButton) {
        throw new Error(`Session button not found: ${sessionId}`)
    }
    return mainButton
}

function clickSession(container: HTMLElement, sessionId: string): void {
    const button = getSessionMainButton(container, sessionId)
    fireEvent.mouseDown(button, { button: 0 })
    fireEvent.mouseUp(button)
}

async function waitForReadHistoryWrite(sessionId: string): Promise<void> {
    await waitFor(() => {
        const history = JSON.parse(localStorage.getItem('hapi:sessionReadHistory') ?? '{}') as Record<string, number>
        expect(history[sessionId]).toBeGreaterThan(0)
    })
}

describe('SessionList DOM freeze behavior', () => {
    beforeEach(() => {
        localStorage.clear()

        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn()
            }))
        })

        if (!globalThis.ResizeObserver) {
            class ResizeObserverMock {
                observe() {}
                unobserve() {}
                disconnect() {}
            }

            Object.defineProperty(globalThis, 'ResizeObserver', {
                writable: true,
                value: ResizeObserverMock
            })
        }
    })

    it('null -> selected applies selection-driven re-sort', async () => {
        const sessions = [
            makeSession({ id: 'anchor', active: true, updatedAt: 100 }),
            makeSession({ id: 'slow', updatedAt: 100 }),
            makeSession({ id: 'fast', updatedAt: 200 })
        ]

        const initialProps = buildProps({ sessions, selectedSessionId: null })
        const view = renderSessionList(initialProps)

        expect(getRenderedSessionOrder(view.container)).toEqual(['fast', 'anchor', 'slow'])

        view.rerenderSessionList({ ...initialProps, selectedSessionId: 'slow' })

        await waitForReadHistoryWrite('slow')

        await waitFor(() => {
            expect(getRenderedSessionOrder(view.container)).toEqual(['fast', 'anchor', 'slow'])
        })
    })

    it('selected + sessions prop update in same tick resolves to stable sorted order', async () => {
        const sessions = [
            makeSession({ id: 'anchor', active: true, updatedAt: 500 }),
            makeSession({ id: 'slow', updatedAt: 100 }),
            makeSession({ id: 'fast', updatedAt: 200 })
        ]

        const initialProps = buildProps({ sessions, selectedSessionId: null })
        const view = renderSessionList(initialProps)

        expect(getRenderedSessionOrder(view.container)).toEqual(['anchor', 'fast', 'slow'])

        const sessionsUpdatedSameTick = [
            makeSession({ id: 'anchor', active: true, updatedAt: 500 }),
            makeSession({ id: 'slow', updatedAt: 900 }),
            makeSession({ id: 'fast', updatedAt: 200 })
        ]

        view.rerenderSessionList({
            ...initialProps,
            selectedSessionId: 'slow',
            sessions: sessionsUpdatedSameTick
        })

        await waitForReadHistoryWrite('slow')

        await waitFor(() => {
            expect(getRenderedSessionOrder(view.container)).toEqual(['anchor', 'fast', 'slow'])
        })
    })

    it('switching selected session freezes immediately, then releases to latest order', async () => {
        const sessions = [
            makeSession({ id: 'anchor', active: true, updatedAt: 500 }),
            makeSession({ id: 'slow', updatedAt: 100 }),
            makeSession({ id: 'fast', updatedAt: 200 })
        ]

        const initialProps = buildProps({ sessions, selectedSessionId: null })
        const view = renderSessionList(initialProps)

        // Baseline order: anchor, fast, slow.
        expect(getRenderedSessionOrder(view.container)).toEqual(['anchor', 'fast', 'slow'])

        // First selection keeps current order because read-history no longer affects rank.
        view.rerenderSessionList({ ...initialProps, selectedSessionId: 'slow' })
        await waitForReadHistoryWrite('slow')
        await waitFor(() => {
            expect(getRenderedSessionOrder(view.container)).toEqual(['anchor', 'fast', 'slow'])
        })

        // Same tick switch selection and update sessions.
        const sessionsUpdatedSameTick = [
            makeSession({ id: 'anchor', active: true, updatedAt: 500 }),
            makeSession({ id: 'slow', updatedAt: 900 }),
            makeSession({ id: 'fast', active: true, updatedAt: 200 })
        ]

        view.rerenderSessionList({
            ...initialProps,
            selectedSessionId: 'fast',
            sessions: sessionsUpdatedSameTick
        })

        await waitForReadHistoryWrite('fast')
        await waitFor(() => {
            expect(getRenderedSessionOrder(view.container)).toEqual(['anchor', 'fast', 'slow'])
        })
    })

    it('deselect unfreezes and re-sorts DOM order', async () => {
        const sessions = [
            makeSession({ id: 'anchor', active: true, updatedAt: 500 }),
            makeSession({ id: 'slow', updatedAt: 100 }),
            makeSession({ id: 'fast', updatedAt: 200 })
        ]

        const initialProps = buildProps({ sessions, selectedSessionId: null })
        const view = renderSessionList(initialProps)

        // Select slow and update sessions in same tick.
        const sessionsUpdated = [
            makeSession({ id: 'anchor', active: true, updatedAt: 500 }),
            makeSession({ id: 'slow', updatedAt: 900 }),
            makeSession({ id: 'fast', updatedAt: 200 })
        ]
        view.rerenderSessionList({ ...initialProps, selectedSessionId: 'slow', sessions: sessionsUpdated })
        await waitForReadHistoryWrite('slow')

        // Deselect should force release and adopt live order.
        view.rerenderSessionList({ ...initialProps, selectedSessionId: null, sessions: sessionsUpdated })

        await waitFor(() => {
            expect(getRenderedSessionOrder(view.container)).toEqual(['slow', 'anchor', 'fast'])
        })
    })
})

describe('SessionList view toggle behavior', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('flat mode hides group headers', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/repo-b' }, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/repo-c' }, updatedAt: 300 }),
        ]

        const view = renderSessionList(buildProps({
            sessions,
            view: 'flat'
        }))

        expect(view.container.querySelectorAll('[data-group-header]')).toHaveLength(0)
        expect(view.container.querySelectorAll('[data-session-project-label]')).toHaveLength(3)
    })

    it('grouped mode unchanged', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/repo-b' }, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/repo-c' }, updatedAt: 300 }),
        ]

        const view = renderSessionList(buildProps({
            sessions,
            view: 'grouped'
        }))

        expect(view.container.querySelectorAll('[data-group-header]')).toHaveLength(3)
        expect(view.container.querySelectorAll('[data-session-project-label]')).toHaveLength(0)
    })

    it('toggle view while session is selected', () => {
        const sessions = [
            makeSession({ id: 'active', metadata: { path: '/repo-a' }, active: true, updatedAt: 100 }),
            makeSession({ id: 'mid', metadata: { path: '/repo-b' }, updatedAt: 200 }),
            makeSession({ id: 'low', metadata: { path: '/repo-c' }, updatedAt: 50 }),
        ]
        const initialProps = buildProps({
            sessions,
            selectedSessionId: 'mid',
            view: 'grouped'
        })
        const view = renderSessionList(initialProps)

        view.rerenderSessionList({
            ...initialProps,
            view: 'flat'
        })

        expect(view.container.querySelectorAll('[data-group-header]')).toHaveLength(0)
        expect(getRenderedSessionOrder(view.container)).toEqual(['mid', 'active', 'low'])
    })

    it('toggle button hidden during selection mode', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' } }),
        ]
        const view = renderSessionList(buildProps({
            sessions,
            view: 'grouped',
            onToggleView: vi.fn()
        }))

        fireEvent.click(getSelectionModeButton(view.container))

        expect(view.container.querySelector('button[title="Flat"]')).toBeNull()
        expect(view.container.querySelector('button[title="Grouped"]')).toBeNull()
    })

    it('prop-driven view change during selection mode preserves selected set', async () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' }, active: true, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/repo-b' }, active: true, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/repo-c' }, active: true, updatedAt: 300 }),
        ]
        const initialProps = buildProps({
            sessions,
            view: 'grouped'
        })
        const view = renderSessionList(initialProps)

        fireEvent.click(getSelectionModeButton(view.container))
        clickSession(view.container, 'a')
        clickSession(view.container, 'b')

        await waitFor(() => {
            expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2)
        })

        view.rerenderSessionList({
            ...initialProps,
            view: 'flat'
        })

        expect(view.container.querySelectorAll('[data-group-header]')).toHaveLength(0)
        expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2)
    })

    it('toggle grouped→flat while selected + session data updates in same tick', async () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/repo-b' }, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/repo-c' }, updatedAt: 50 }),
        ]
        const initialProps = buildProps({
            sessions,
            selectedSessionId: null,
            view: 'grouped'
        })
        const view = renderSessionList(initialProps)

        view.rerenderSessionList({ ...initialProps, selectedSessionId: 'a' })
        await waitForReadHistoryWrite('a')

        const updatedSessions = [
            makeSession({ id: 'a', metadata: { path: '/repo-a' }, active: true, updatedAt: 400 }),
            makeSession({ id: 'b', metadata: { path: '/repo-b' }, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/repo-c' }, updatedAt: 50 }),
        ]

        view.rerenderSessionList({
            ...initialProps,
            sessions: updatedSessions,
            selectedSessionId: 'a',
            view: 'flat'
        })

        await waitFor(() => {
            expect(view.container.querySelectorAll('[data-group-header]')).toHaveLength(0)
            expect(getRenderedSessionOrder(view.container)).toEqual(['a', 'b', 'c'])
            expect(view.container.querySelectorAll('[data-session-project-label]')).toHaveLength(3)
        })
    })
})
