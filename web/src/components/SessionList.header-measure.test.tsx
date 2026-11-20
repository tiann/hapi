import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const PROJECT_PATH = '/work/test'
const OPEN_SESSION_ID = 's-1'

const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
let observers: TestResizeObserver[] = []

class TestResizeObserver {
    readonly targets = new Set<Element>()
    constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    fire(target?: Element) {
        const entries = target ? [{
            target,
            contentRect: { width: 300, height: 40 } as DOMRectReadOnly,
        } as ResizeObserverEntry] : []
        this.callback(entries, this as unknown as ResizeObserver)
    }
}

function resize(target: Element) {
    act(() => {
        for (const observer of observers) {
            if (observer.targets.has(target)) observer.fire(target)
        }
    })
}

beforeEach(() => {
    observers = []
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: TestResizeObserver,
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    if (originalResizeObserver) {
        Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver)
    } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
})

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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides,
    }
}

function sessions(count = 5): SessionSummary[] {
    return Array.from({ length: count }, (_, index) => makeSession({
        id: `s-${index + 1}`,
        updatedAt: 1000 - index,
        metadata: { path: PROJECT_PATH, name: `Session ${index + 1}`, flavor: 'codex' },
    }))
}

function renderSessionList(initialSessions: SessionSummary[], extraProps?: Partial<Parameters<typeof SessionList>[0]>) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={initialSessions}
                        selectedSessionId={OPEN_SESSION_ID}
                        onSelect={vi.fn()}
                        onNewSession={vi.fn()}
                        onRefresh={vi.fn()}
                        isLoading={false}
                        renderHeader={true}
                        api={null}
                        {...extraProps}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

describe('SessionList header measurement optimization', () => {
    it('does not re-measure search chrome when only session row data changes', () => {
        const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle')
        const getSearchStyleReads = () => getComputedStyleSpy.mock.calls.filter(
            ([el]) => el instanceof HTMLElement && el.getAttribute('data-testid') === 'session-list-search'
        ).length

        const initial = sessions(5)
        const { rerender } = renderSessionList(initial)

        expect(getSearchStyleReads()).toBe(1)

        // Simulate SSE update: session list re-renders with updated session timestamps
        const updated = sessions(5).map((s, idx) => idx === 0 ? { ...s, updatedAt: s.updatedAt + 10 } : s)
        rerender(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={updated}
                            selectedSessionId={OPEN_SESSION_ID}
                            onSelect={vi.fn()}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={true}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        // Session row data changed, but search chrome / header control configuration did not change.
        // It must NOT re-measure search chrome.
        expect(getSearchStyleReads()).toBe(1)
    })

    it('re-measures search chrome when search element or chrome parts resize via ResizeObserver', () => {
        const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle')
        const getSearchStyleReads = () => getComputedStyleSpy.mock.calls.filter(
            ([el]) => el instanceof HTMLElement && el.getAttribute('data-testid') === 'session-list-search'
        ).length

        renderSessionList(sessions(5))

        expect(getSearchStyleReads()).toBe(1)

        const searchElement = document.querySelector('[data-testid="session-list-search"]')
        expect(searchElement).not.toBeNull()
        if (searchElement) {
            resize(searchElement)
            expect(getSearchStyleReads()).toBe(2)
        }

        const chromePart = document.querySelector('[data-toolbar-chrome]')
        expect(chromePart).not.toBeNull()
        if (chromePart) {
            resize(chromePart)
            expect(getSearchStyleReads()).toBe(3)
        }
    })

    it('re-measures search chrome on expand and collapse', async () => {
        const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle')
        const getSearchStyleReads = () => getComputedStyleSpy.mock.calls.filter(
            ([el]) => el instanceof HTMLElement && el.getAttribute('data-testid') === 'session-list-search'
        ).length

        renderSessionList(sessions(5))
        const initialReads = getSearchStyleReads()
        expect(initialReads).toBe(1)

        const searchButton = screen.getByRole('button', { name: /search/i })
        act(() => {
            fireEvent.click(searchButton)
        })

        // Expanding search marks dirty and triggers layout effect re-measure
        expect(getSearchStyleReads()).toBeGreaterThanOrEqual(initialReads)

        // Blurring the search input collapses search and marks dirty again
        const searchInput = screen.getByRole('searchbox')
        act(() => {
            fireEvent.blur(searchInput, { relatedTarget: document.body })
        })

        expect(getSearchStyleReads()).toBeGreaterThanOrEqual(initialReads + 1)
    })

    it('falls back to measuring every commit when ResizeObserver is undefined', () => {
        Reflect.deleteProperty(globalThis, 'ResizeObserver')

        const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle')
        const getSearchStyleReads = () => getComputedStyleSpy.mock.calls.filter(
            ([el]) => el instanceof HTMLElement && el.getAttribute('data-testid') === 'session-list-search'
        ).length

        const initial = sessions(5)
        const { rerender } = renderSessionList(initial)

        const initialReads = getSearchStyleReads()
        expect(initialReads).toBeGreaterThanOrEqual(1)

        const updated = sessions(5).map((s, idx) => idx === 0 ? { ...s, updatedAt: s.updatedAt + 10 } : s)
        rerender(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={updated}
                            selectedSessionId={OPEN_SESSION_ID}
                            onSelect={vi.fn()}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={true}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        // Without ResizeObserver, it falls back to measuring on every commit (reads increase)
        expect(getSearchStyleReads()).toBeGreaterThan(initialReads)
    })

    it('re-measures search chrome and sets minWidth floor when collapsing search with a non-empty query', async () => {
        const ICON_WIDTH = 28
        const CLEAR_BUTTON_WIDTH = 36
        const offsetWidthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
            if (this.tagName === 'SPAN' && this.hasAttribute('data-toolbar-chrome')) return ICON_WIDTH
            if (this.tagName === 'BUTTON' && this.hasAttribute('data-toolbar-chrome')) return CLEAR_BUTTON_WIDTH
            return 0
        })

        const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle')
        const getSearchStyleReads = () => getComputedStyleSpy.mock.calls.filter(
            ([el]) => el instanceof HTMLElement && el.getAttribute('data-testid') === 'session-list-search'
        ).length

        renderSessionList(sessions(5))
        const initialReads = getSearchStyleReads()
        expect(initialReads).toBe(1)

        // Expand search
        const searchButton = screen.getByRole('button', { name: /search/i })
        act(() => {
            fireEvent.click(searchButton)
        })

        // Type a query so that when collapsed, the clear button should be rendered and measured
        const searchInput = screen.getByRole('searchbox')
        act(() => {
            fireEvent.change(searchInput, { target: { value: 'bug' } })
        })

        const readsBeforeBlur = getSearchStyleReads()

        // Collapse search by blurring the input
        act(() => {
            fireEvent.blur(searchInput, { relatedTarget: document.body })
        })

        // Flush microtasks for MutationObserver
        await act(async () => {
            await Promise.resolve()
        })

        // On collapse with a non-empty query, search chrome must be re-measured exactly once synchronously
        expect(getSearchStyleReads()).toBe(readsBeforeBlur + 1)

        // And the search element should have the exact combined floor (icon + clear button + padding)
        const searchElement = document.querySelector<HTMLElement>('[data-testid="session-list-search"]')
        const trigger = searchElement?.querySelector('button')
        const triggerStyle = trigger ? window.getComputedStyle(trigger) : null
        const triggerPad = triggerStyle
            ? (Number.parseFloat(triggerStyle.paddingLeft) || 0) + (Number.parseFloat(triggerStyle.paddingRight) || 0)
            : 0
        const expectedFloor = ICON_WIDTH + CLEAR_BUTTON_WIDTH + triggerPad
        expect(searchElement?.style.minWidth).toBe(`${expectedFloor}px`)

        offsetWidthSpy.mockRestore()
    })

    it('does not re-render or measure when search subtree mutates while expanded', async () => {
        renderSessionList(sessions(5))

        // Expand search
        const searchButton = screen.getByRole('button', { name: /search/i })
        act(() => {
            fireEvent.click(searchButton)
        })

        const headerRow = document.querySelector<HTMLElement>('[data-testid="session-list-header-row"]')
        expect(headerRow).not.toBeNull()
        const querySpy = vi.spyOn(headerRow!, 'querySelector')

        // Click search scope toggle to open the include/exclude menu while expanded
        const scopeToggle = screen.getByRole('button', { name: 'Search scope' })
        act(() => {
            fireEvent.click(scopeToggle)
        })

        // Give MutationObserver a tick to fire if it wasn't ignored
        await act(async () => {
            await Promise.resolve()
        })

        // Opening the menu must not cause the parent SessionList to re-render or re-measure
        expect(querySpy).not.toHaveBeenCalled()
    })

    it('unobserves the search root and its chrome parts when the list empties', () => {
        const initial = sessions(5)
        const { rerender } = renderSessionList(initial, { renderHeader: true })

        const searchElement = document.querySelector<HTMLElement>('[data-testid="session-list-search"]')
        expect(searchElement).not.toBeNull()

        const ro = observers[0]
        expect(ro).toBeDefined()
        expect(ro.targets.has(searchElement!)).toBe(true)

        // Empty the sessions list so that the search root unmounts while header row stays mounted
        rerender(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={[]}
                            selectedSessionId={OPEN_SESSION_ID}
                            onSelect={vi.fn()}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={true}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        // Search element is unmounted
        expect(document.querySelector('[data-testid="session-list-search"]')).toBeNull()

        // The detached search element must be unobserved from ResizeObserver
        expect(ro.targets.has(searchElement!)).toBe(false)
    })
})
