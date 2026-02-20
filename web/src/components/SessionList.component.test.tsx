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
        sortOrder: null,
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
        api: {
            setSessionSortOrder: vi.fn().mockResolvedValue(undefined)
        } as unknown as SessionListProps['api'],
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

describe('SessionList ordering + DnD UI', () => {
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

    it('flat mode orders globally by sortOrder', () => {
        const sessions = [
            makeSession({ id: 'c', sortOrder: 'c', metadata: { path: '/repo-c' } }),
            makeSession({ id: 'a', sortOrder: 'a', metadata: { path: '/repo-a' } }),
            makeSession({ id: 'b', sortOrder: 'b', metadata: { path: '/repo-b' } }),
        ]

        const view = renderSessionList(buildProps({
            sessions,
            view: 'flat'
        }))

        expect(getRenderedSessionOrder(view.container)).toEqual(['a', 'b', 'c'])
        expect(view.container.querySelectorAll('[data-group-header]')).toHaveLength(0)
    })

    it('grouped mode orders groups by min sortOrder and sessions by sortOrder', () => {
        const sessions = [
            makeSession({ id: 'g1-b', sortOrder: 'd', metadata: { path: '/group-one' }, active: true }),
            makeSession({ id: 'g1-a', sortOrder: 'c', metadata: { path: '/group-one' } }),
            makeSession({ id: 'g2-a', sortOrder: 'a', metadata: { path: '/group-two' }, active: true }),
        ]

        const view = renderSessionList(buildProps({
            sessions,
            view: 'grouped'
        }))

        const groupHeaders = Array.from(view.container.querySelectorAll<HTMLElement>('[data-group-header]'))
            .map(el => el.dataset.groupHeader)

        expect(groupHeaders).toEqual(['/group-two', '/group-one'])
        expect(getRenderedSessionOrder(view.container)).toEqual(['g2-a', 'g1-a', 'g1-b'])
    })

    it('renders always-visible drag handles with aria labels + instructions', () => {
        const sessions = [
            makeSession({ id: 'alpha', sortOrder: 'a', metadata: { path: '/repo-a', name: 'Alpha' } }),
            makeSession({ id: 'beta', sortOrder: 'b', metadata: { path: '/repo-b', name: 'Beta' } }),
        ]

        const view = renderSessionList(buildProps({ sessions, view: 'flat' }))

        const handleButtons = view.container.querySelectorAll<HTMLButtonElement>('[data-drag-handle]')
        expect(handleButtons).toHaveLength(2)
        expect(handleButtons[0]?.className).toContain('self-stretch')
        expect(handleButtons[0]?.className).toContain('w-11')

        expect(view.container.querySelectorAll('#session-dnd-instructions').length).toBeGreaterThan(0)
        expect(handleButtons[0]?.getAttribute('aria-label')).toContain('Reorder session')
    })

    it('disables dnd handles in selection mode', async () => {
        const sessions = [
            makeSession({ id: 'alpha', sortOrder: 'a', metadata: { path: '/repo-a', name: 'Alpha' } }),
            makeSession({ id: 'beta', sortOrder: 'b', metadata: { path: '/repo-b', name: 'Beta' } }),
        ]

        const view = renderSessionList(buildProps({ sessions, view: 'flat' }))

        fireEvent.click(getSelectionModeButton(view.container))

        await waitFor(() => {
            const handles = view.container.querySelectorAll<HTMLButtonElement>('[data-drag-handle]')
            expect(handles[0]).toBeDisabled()
            expect(handles[1]).toBeDisabled()
        })
    })
})
