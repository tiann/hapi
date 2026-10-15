import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const PROJECT_PATH = '/work/proj'
const OPEN_SESSION_ID = 's-open'
const TICK_SELECTOR = '.session-list-open-tick'

const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
let observers: TestResizeObserver[] = []

/** Records what each observer watches so a resize can be delivered per element. */
class TestResizeObserver {
    readonly targets = new Set<Element>()
    constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    fire() { this.callback([], this as unknown as ResizeObserver) }
}

/** Resize one element — observers that never watched it stay silent, as in a browser. */
function resize(target: Element) {
    act(() => {
        for (const observer of observers) {
            if (observer.targets.has(target)) observer.fire()
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
        model: null,
        effort: null,
        ...overrides,
    }
}

function sessions(): SessionSummary[] {
    return Array.from({ length: 6 }, (_, index) => makeSession({
        id: index === 0 ? OPEN_SESSION_ID : `s-${index}`,
        updatedAt: 1000 - index,
        metadata: { path: PROJECT_PATH, name: `Session ${index}`, flavor: 'codex' },
    }))
}

function renderList() {
    return render(
        <QueryClientProvider
            client={new QueryClient({
                defaultOptions: {
                    queries: { retry: false },
                    mutations: { retry: false },
                },
            })}
        >
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={sessions()}
                        selectedSessionId={OPEN_SESSION_ID}
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
}

/** jsdom has no layout engine: fake the scroll extent and the open row's box. */
type Layout = { scrollHeight: number; rowTop: number }

function stubLayout(container: HTMLElement, row: HTMLElement, layout: Layout) {
    Object.defineProperty(container, 'scrollHeight', {
        configurable: true,
        get: () => layout.scrollHeight,
    })
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 400 })
    container.getBoundingClientRect = () => ({ top: 0, height: 400 }) as DOMRect
    row.getBoundingClientRect = () => ({ top: layout.rowTop, height: 40 }) as DOMRect
}

function expectedTop(layout: Layout): string {
    return `${((layout.rowTop + 20) / layout.scrollHeight) * 100}%`
}

/** Longer than TICK_RECOMPUTE_THROTTLE_MS so a throttled recompute has landed. */
async function flushTick() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 180))
    })
}

function tickTop(): string | null {
    return document.querySelector<HTMLElement>(TICK_SELECTOR)?.style.top ?? null
}

function listParts() {
    const container = document.querySelector<HTMLElement>('.session-list-scrollbar-left')
    expect(container).toBeTruthy()
    const content = container!.firstElementChild as HTMLElement
    expect(content).toBeTruthy()
    const marked = container!.querySelector<HTMLElement>('[aria-current="page"]')
    const row = marked?.closest<HTMLElement>('.session-list-item') ?? marked
    expect(row).toBeTruthy()
    return { container: container!, content, row: row! }
}

describe('SessionList open-session scroll tick', () => {
    it('follows the open row when an animated collapse resizes only the content (#1733 review)', async () => {
        renderList()
        const { container, content, row } = listParts()

        const layout: Layout = { scrollHeight: 1000, rowTop: 300 }
        stubLayout(container, row, layout)
        resize(container)
        await flushTick()
        expect(tickTop()).toBe(expectedTop(layout))

        // A section above the open row collapses. `.collapsible-panel` animates
        // `grid-template-rows` for 250ms, so the scroll container's own box never
        // changes — only the scrolled content shrinks. Watching the container
        // alone leaves the mark at the pre-collapse position.
        layout.scrollHeight = 700
        layout.rowTop = 100
        resize(content)
        await flushTick()
        expect(tickTop()).toBe(expectedTop(layout))
    })

    it('recomputes once the collapse transition finishes', async () => {
        renderList()
        const { container, content, row } = listParts()

        const layout: Layout = { scrollHeight: 1000, rowTop: 300 }
        stubLayout(container, row, layout)
        resize(container)
        await flushTick()
        expect(tickTop()).toBe(expectedTop(layout))

        // Last animation frame lands without a further resize notification.
        layout.scrollHeight = 850
        layout.rowTop = 180
        act(() => {
            const event = new Event('transitionend', { bubbles: true })
            Object.defineProperty(event, 'propertyName', { value: 'grid-template-rows' })
            content.dispatchEvent(event)
        })
        await flushTick()
        expect(tickTop()).toBe(expectedTop(layout))
    })

    it('hides the tick when the open row sits in a collapsed group', async () => {
        renderList()
        const { container, row } = listParts()

        stubLayout(container, row, { scrollHeight: 1000, rowTop: 300 })
        resize(container)
        await flushTick()
        expect(document.querySelector(TICK_SELECTOR)).toBeTruthy()

        const panel = row.closest('.collapsible-panel') as HTMLElement
        expect(panel).toBeTruthy()
        act(() => {
            panel.removeAttribute('data-open')
        })
        await flushTick()
        expect(document.querySelector(TICK_SELECTOR)).toBeNull()
    })
})
