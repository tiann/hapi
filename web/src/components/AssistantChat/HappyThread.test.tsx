import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const virtualThread = vi.hoisted(() => ({
    anchorDocumentTop: 320,
    anchorMounted: true,
    restoreCalls: [] as Array<{ id: string; offset: number }>,
    restoreResults: [] as Array<{
        found: boolean
        mounted: boolean
        deviation: number | null
    }>,
}))

vi.mock('@assistant-ui/react', () => ({
    useAssistantState: (selector: (state: { thread: { messages: Array<{ id: string }> } }) => unknown) => (
        selector({ thread: { messages: [
            { id: 'message-1' },
            { id: 'message-2' },
            { id: 'message-3' },
        ] } })
    ),
    ThreadPrimitive: {
        Root: ({ children, className }: { children: ReactNode; className?: string }) => (
            <div data-testid="thread-root" className={className}>{children}</div>
        ),
        Viewport: ({ children }: { asChild?: boolean; autoScroll?: boolean; children: ReactNode }) => <>{children}</>,
        Messages: () => <div data-testid="thread-messages" />,
        MessageByIndex: ({ index }: { index: number }) => <div data-testid={`thread-message-${index}`} />,
    },
}))

vi.mock('@/components/AssistantChat/messages/AssistantMessage', () => ({
    HappyAssistantMessage: () => null,
}))
vi.mock('@/components/AssistantChat/messages/UserMessage', () => ({
    HappyUserMessage: () => null,
}))
vi.mock('@/components/AssistantChat/messages/SystemMessage', () => ({
    HappySystemMessage: () => null,
}))
vi.mock('@/components/AssistantChat/VirtualizedThreadMessages', () => ({
    VirtualizedThreadMessages: ({ ref }: {
        ref?: { current: null | { restoreMessageAnchor: (id: string, offset: number) => unknown } }
    }) => {
        if (ref) {
            ref.current = {
                restoreMessageAnchor: (id: string, offset: number) => {
                    virtualThread.restoreCalls.push({ id, offset })
                    const queued = virtualThread.restoreResults.shift()
                    if (queued) return queued
                    const viewport = document.querySelector('.app-scroll-y')
                    const row = document.querySelector(`[data-hapi-message-id="${id}"]`)
                    if (!(viewport instanceof HTMLElement) || !(row instanceof HTMLElement)) {
                        return { found: true, mounted: false, deviation: null }
                    }
                    const deviation = row.getBoundingClientRect().top
                        - viewport.getBoundingClientRect().top
                        - offset
                    viewport.scrollTop += deviation
                    return { found: true, mounted: true, deviation }
                },
            }
        }
        return (
            <div className="happy-thread-messages" data-testid="virtual-thread-messages">
                {virtualThread.anchorMounted ? (
                    <div
                        data-testid="anchor-message"
                        data-hapi-message-id="anchor-message"
                        data-document-top={virtualThread.anchorDocumentTop}
                    />
                ) : null}
            </div>
        )
    },
}))
vi.mock('@/components/ui/button', () => ({
    Button: ({ children, variant: _variant, size: _size, ...rest }: { children: ReactNode; variant?: string; size?: string }) => (
        <button {...rest}>{children}</button>
    ),
}))
vi.mock('@/components/Spinner', () => ({
    Spinner: () => <span data-testid="spinner" />,
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string, values?: Record<string, unknown>) => (
            values && 'n' in values ? `${values.n} new messages` : key
        ),
    }),
}))

import { HappyThread } from './HappyThread'

type HappyThreadProps = ComponentProps<typeof HappyThread>

const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

let rafCallbacks: FrameRequestCallback[] = []

function restoreDescriptor(name: 'scrollHeight' | 'clientHeight' | 'scrollTo', descriptor: PropertyDescriptor | undefined) {
    if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor)
        return
    }
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
}

function flushOneAnimationFrame() {
    const callback = rafCallbacks.shift()
    if (callback) {
        callback(performance.now())
    }
}

function buildThreadProps(overrides: Partial<HappyThreadProps> = {}): HappyThreadProps {
    return {
        api: {} as HappyThreadProps['api'],
        sessionId: 'session-1',
        metadata: null,
        disabled: false,
        onRefresh: vi.fn(),
        onRetryMessage: vi.fn(),
        onFlushPending: vi.fn(),
        onAtBottomChange: vi.fn(),
        isLoadingMessages: false,
        messagesWarning: null,
        hasMoreMessages: false,
        hasNewerMessages: false,
        isLoadingMoreMessages: false,
        isLoadingNewerMessages: false,
        onLoadMore: vi.fn(async () => {}),
        onLoadNewer: vi.fn(async () => {}),
        onReturnToLatest: vi.fn(async () => {}),
        pendingCount: 0,
        rawMessagesCount: 3,
        normalizedMessagesCount: 3,
        messagesVersion: 1,
        forceScrollToken: 0,
        ...overrides,
    }
}

function renderThread(overrides: Partial<HappyThreadProps> = {}) {
    return render(<HappyThread {...buildThreadProps(overrides)} />)
}

class ImmediateIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: ReadonlyArray<number> = []

    constructor(private readonly callback: IntersectionObserverCallback) {}

    disconnect = vi.fn()
    observe = vi.fn((target: Element) => {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this)
    })
    takeRecords = vi.fn((): IntersectionObserverEntry[] => [])
    unobserve = vi.fn()
}

describe('HappyThread initial scroll positioning', () => {
    beforeEach(() => {
        rafCallbacks = []
        virtualThread.anchorDocumentTop = 320
        virtualThread.anchorMounted = true
        virtualThread.restoreCalls = []
        virtualThread.restoreResults = []
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get: () => 1000,
        })
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get: () => 400,
        })
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: vi.fn(function (this: HTMLElement, options?: ScrollToOptions) {
                if (options && typeof options.top === 'number') {
                    this.scrollTop = options.top
                }
            }),
        })
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            rafCallbacks.push(callback)
            return rafCallbacks.length
        })
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
    })

    afterEach(() => {
        cleanup()
        vi.useRealTimers()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        restoreDescriptor('scrollHeight', originalScrollHeight)
        restoreDescriptor('clientHeight', originalClientHeight)
        restoreDescriptor('scrollTo', originalScrollTo)
        rafCallbacks = []
    })

    it('uses an instant bottom scroll after the first message page renders', () => {
        const onFlushPending = vi.fn()

        renderThread({ onFlushPending })

        act(() => {
            flushOneAnimationFrame()
        })

        expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
        expect(onFlushPending).toHaveBeenCalled()
    })

    it('keeps the initial bottom scroll active while first page layout height settles', () => {
        let scrollHeight = 100
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        })

        renderThread()

        act(() => {
            flushOneAnimationFrame()
        })
        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: 'auto' })

        scrollHeight = 1000
        act(() => {
            flushOneAnimationFrame()
        })

        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' })
    })

    it('does not request older messages before the initial bottom scroll settles', async () => {
        const onLoadMore = vi.fn(async () => {})
        vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)

        renderThread({
            hasMoreMessages: true,
            onLoadMore,
        })
        await act(async () => {
            await Promise.resolve()
        })

        expect(onLoadMore).not.toHaveBeenCalled()
    })

    it('allows the top sentinel to request older messages after the initial scroll settles', async () => {
        const onLoadMore = vi.fn(async () => {})
        vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)

        renderThread({
            hasMoreMessages: true,
            onLoadMore,
        })

        act(() => {
            flushOneAnimationFrame()
            flushOneAnimationFrame()
            flushOneAnimationFrame()
        })
        await act(async () => {
            await Promise.resolve()
        })

        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('uses exact return-to-latest for the new-message indicator before scrolling', async () => {
        const onFlushPending = vi.fn()
        const onReturnToLatest = vi.fn(async () => {})

        renderThread({
            pendingCount: 2,
            onFlushPending,
            onReturnToLatest,
        })

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '2 new messages ↓' }))
        })

        expect(onReturnToLatest).toHaveBeenCalledTimes(1)
        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'smooth' })
        expect(onFlushPending).not.toHaveBeenCalled()
    })

    it('reports a physical bottom with newer history as not being at the live bottom', () => {
        const onAtBottomChange = vi.fn()
        const onFlushPending = vi.fn()
        const { container } = renderThread({
            hasNewerMessages: true,
            onAtBottomChange,
            onFlushPending,
        })
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 600

        fireEvent.scroll(viewport)

        expect(onAtBottomChange).toHaveBeenLastCalledWith(false)
        expect(onFlushPending).not.toHaveBeenCalled()
    })

    it('loads newer history without invoking older or exact-latest actions', async () => {
        const onLoadMore = vi.fn(async () => {})
        const onLoadNewer = vi.fn(async () => {})
        const onReturnToLatest = vi.fn(async () => {})
        renderThread({
            hasNewerMessages: true,
            onLoadMore,
            onLoadNewer,
            onReturnToLatest,
        })

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'misc.loadNewer' }))
        })

        expect(onLoadNewer).toHaveBeenCalledTimes(1)
        expect(onLoadMore).not.toHaveBeenCalled()
        expect(onReturnToLatest).not.toHaveBeenCalled()
    })

    it('awaits exact latest before scrolling the viewport', async () => {
        let resolveLatest!: () => void
        const latestPromise = new Promise<void>((resolve) => {
            resolveLatest = resolve
        })
        const onReturnToLatest = vi.fn(() => latestPromise)
        renderThread({
            hasNewerMessages: true,
            onReturnToLatest,
        })
        vi.mocked(HTMLElement.prototype.scrollTo).mockClear()

        fireEvent.click(screen.getByRole('button', { name: 'misc.returnToLatest' }))
        expect(onReturnToLatest).toHaveBeenCalledTimes(1)
        expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled()

        await act(async () => {
            resolveLatest()
            await latestPromise
        })

        expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })
    })

    it('keeps exact-latest bottom positioning active while the replacement page lays out', async () => {
        let scrollHeight = 1000
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        })
        const onReturnToLatest = vi.fn(async () => {})
        renderThread({
            hasNewerMessages: true,
            onReturnToLatest,
        })
        rafCallbacks = []
        vi.mocked(HTMLElement.prototype.scrollTo).mockClear()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'misc.returnToLatest' }))
        })
        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({
            top: 1000,
            behavior: 'smooth',
        })

        scrollHeight = 2000
        act(() => {
            flushOneAnimationFrame()
        })

        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({
            top: 2000,
            behavior: 'auto',
        })
    })

    it('restarts exact-latest positioning when the replacement message version commits', async () => {
        let scrollHeight = 1000
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        })
        const onReturnToLatest = vi.fn(async () => {})
        const { rerender } = render(<HappyThread {...buildThreadProps({
            hasNewerMessages: true,
            onReturnToLatest,
            messagesVersion: 1,
        })} />)
        act(() => {
            flushOneAnimationFrame()
            flushOneAnimationFrame()
            flushOneAnimationFrame()
        })
        rafCallbacks = []

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'misc.returnToLatest' }))
        })
        act(() => {
            for (let frame = 0; frame < 10; frame += 1) {
                flushOneAnimationFrame()
            }
        })
        rafCallbacks = []
        vi.mocked(HTMLElement.prototype.scrollTo).mockClear()

        scrollHeight = 2000
        rerender(<HappyThread {...buildThreadProps({
            hasNewerMessages: false,
            onReturnToLatest,
            messagesVersion: 2,
        })} />)
        act(() => {
            flushOneAnimationFrame()
        })

        expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
            top: 2000,
            behavior: 'auto',
        })
    })

    it('keeps the review position when exact latest reports failure', async () => {
        const onReturnToLatest = vi.fn(async () => false)
        renderThread({
            hasNewerMessages: true,
            onReturnToLatest,
        })
        vi.mocked(HTMLElement.prototype.scrollTo).mockClear()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'misc.returnToLatest' }))
        })

        expect(onReturnToLatest).toHaveBeenCalledTimes(1)
        expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled()
    })

    it('restores a stable visible-message anchor within two pixels after loading history', async () => {
        let resolveLoad!: () => void
        const loadPromise = new Promise<void>((resolve) => {
            resolveLoad = resolve
        })
        const onLoadMore = vi.fn(() => loadPromise)
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })
        const originalOffset = screen.getByTestId('anchor-message').getBoundingClientRect().top

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        virtualThread.anchorDocumentTop = 440
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)

        const restoredOffset = screen.getByTestId('anchor-message').getBoundingClientRect().top
        expect(Math.abs(restoredOffset - originalOffset)).toBeLessThanOrEqual(2)

        await act(async () => {
            resolveLoad()
            await loadPromise
        })
    })

    it('keeps restoring when virtualized layout shifts after two exact frames', () => {
        const onLoadMore = vi.fn(() => new Promise<void>(() => {}))
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.restoreResults = [
            { found: true, mounted: true, deviation: 0 },
            { found: true, mounted: true, deviation: 0 },
            { found: true, mounted: true, deviation: 120 },
            ...Array.from({ length: 8 }, () => ({
                found: true,
                mounted: true,
                deviation: 0,
            })),
        ]
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)

        act(() => {
            for (let frame = 0; frame < 30 && virtualThread.restoreCalls.length < 11; frame += 1) {
                flushOneAnimationFrame()
            }
        })

        expect(virtualThread.restoreCalls).toHaveLength(11)
    })

    it('asks the virtualizer to seek an anchor that is unmounted after a large history prepend', async () => {
        let resolveLoad!: () => void
        const loadPromise = new Promise<void>((resolve) => {
            resolveLoad = resolve
        })
        const onLoadMore = vi.fn(() => loadPromise)
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.anchorMounted = false
        virtualThread.restoreResults = [
            { found: true, mounted: false, deviation: null },
            { found: true, mounted: false, deviation: null },
            { found: true, mounted: false, deviation: null },
            { found: true, mounted: false, deviation: null },
            { found: true, mounted: false, deviation: null },
            ...Array.from({ length: 8 }, () => ({
                found: true,
                mounted: true,
                deviation: 0,
            })),
        ]
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)

        act(() => {
            for (let frame = 0; frame < 30 && virtualThread.restoreCalls.length < 13; frame += 1) {
                flushOneAnimationFrame()
            }
        })

        expect(virtualThread.restoreCalls).toHaveLength(13)
        expect(virtualThread.restoreCalls).toEqual(
            Array.from({ length: 13 }, () => ({ id: 'anchor-message', offset: 120 })),
        )

        await act(async () => {
            resolveLoad()
            await loadPromise
        })
    })

    it.each([
        ['wheels', (viewport: HTMLElement) => fireEvent.wheel(viewport, { deltaY: -120 })],
        ['touches', (viewport: HTMLElement) => fireEvent.touchStart(viewport)],
        ['presses the pointer', (viewport: HTMLElement) => fireEvent.pointerDown(viewport)],
        ['presses PageDown', () => fireEvent.keyDown(window, { key: 'PageDown' })],
    ])('stops restoring a history anchor when the user %s', (_label, interrupt) => {
        const onLoadMore = vi.fn(() => new Promise<void>(() => {}))
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            return new DOMRect(0, 120, 800, 72)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.anchorMounted = false
        virtualThread.restoreResults = Array.from({ length: 10 }, () => ({
            found: true,
            mounted: false,
            deviation: null,
        }))
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)
        expect(virtualThread.restoreCalls).toHaveLength(1)

        interrupt(viewport)
        act(() => {
            for (let frame = 0; frame < 5; frame += 1) {
                flushOneAnimationFrame()
            }
        })

        expect(virtualThread.restoreCalls).toHaveLength(1)
    })

    it('keeps anchor restoration active beyond the legacy two-second cleanup window', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            rafCallbacks.push(callback)
            return rafCallbacks.length
        })
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
        let resolveLoad!: () => void
        const loadPromise = new Promise<void>((resolve) => {
            resolveLoad = resolve
        })
        const onLoadMore = vi.fn(() => loadPromise)
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.anchorMounted = false
        virtualThread.restoreResults = [
            { found: true, mounted: false, deviation: null },
            ...Array.from({ length: 8 }, () => ({
                found: true,
                mounted: true,
                deviation: 0,
            })),
        ]
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)
        expect(virtualThread.restoreCalls).toHaveLength(1)

        await act(async () => {
            resolveLoad()
            await loadPromise
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(vi.getTimerCount()).toBeGreaterThan(0)
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_001)
        })
        act(() => {
            for (let frame = 0; frame < 30 && virtualThread.restoreCalls.length < 9; frame += 1) {
                flushOneAnimationFrame()
            }
        })

        expect(virtualThread.restoreCalls).toHaveLength(9)
    })

    it('uses the four-second deadline instead of expiring after 120 animation frames', () => {
        let now = 0
        vi.spyOn(performance, 'now').mockImplementation(() => now)
        const onLoadMore = vi.fn(() => new Promise<void>(() => {}))
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.anchorMounted = false
        virtualThread.restoreResults = [
            ...Array.from({ length: 121 }, () => ({
                found: true,
                mounted: false,
                deviation: null,
            })),
            ...Array.from({ length: 8 }, () => ({
                found: true,
                mounted: true,
                deviation: 0,
            })),
        ]
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)

        act(() => {
            for (let frame = 0; frame < 140 && virtualThread.restoreCalls.length < 129; frame += 1) {
                now += 1_000 / 60
                flushOneAnimationFrame()
            }
        })

        expect(now).toBeLessThan(4_000)
        expect(virtualThread.restoreCalls).toHaveLength(129)
    })

    it('does not restart the four-second anchor deadline on later message versions', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            rafCallbacks.push(callback)
            return rafCallbacks.length
        })
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
        const onLoadMore = vi.fn(() => new Promise<void>(() => {}))
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.anchorMounted = false
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)

        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_500)
        })
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 3,
        })} />)
        await act(async () => {
            await vi.advanceTimersByTimeAsync(501)
        })
        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))

        expect(onLoadMore).toHaveBeenCalledTimes(2)
    })

    it('does not restore an anchor from a delayed animation frame at the four-second deadline', () => {
        let now = 0
        vi.spyOn(performance, 'now').mockImplementation(() => now)
        const onLoadMore = vi.fn(() => new Promise<void>(() => {}))
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 200
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.anchorMounted = false
        virtualThread.restoreResults = [
            { found: true, mounted: false, deviation: null },
            { found: true, mounted: true, deviation: 100 },
        ]
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)
        expect(virtualThread.restoreCalls).toHaveLength(1)

        now = 4_000
        act(() => {
            for (let frame = 0; frame < 20 && rafCallbacks.length > 0; frame += 1) {
                flushOneAnimationFrame()
            }
        })

        expect(virtualThread.restoreCalls).toHaveLength(1)
    })

    it('adds temporary tail room when the exact anchor target is beyond the physical scroll range', () => {
        const onLoadMore = vi.fn(async () => {})
        const { container, rerender } = render(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 1,
        })} />)
        const viewport = container.querySelector('.app-scroll-y') as HTMLDivElement
        viewport.scrollTop = 600
        virtualThread.anchorDocumentTop = 720
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('app-scroll-y')) {
                return new DOMRect(0, 0, 800, 400)
            }
            if (this.dataset.hapiMessageId === 'anchor-message') {
                return new DOMRect(0, virtualThread.anchorDocumentTop - viewport.scrollTop, 800, 72)
            }
            return new DOMRect(0, 0, 800, 0)
        })

        fireEvent.click(screen.getByRole('button', { name: 'misc.loadOlder' }))
        virtualThread.restoreResults = [
            { found: true, mounted: true, deviation: 200 },
        ]
        rerender(<HappyThread {...buildThreadProps({
            hasMoreMessages: true,
            onLoadMore,
            messagesVersion: 2,
        })} />)

        expect(screen.getByTestId('anchor-tail-spacer')).toHaveStyle({ height: '200px' })
    })

    it('settles the initial scroll after the maximum frame budget if layout height keeps changing', () => {
        const onLoadMore = vi.fn(async () => {})
        vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
        let scrollHeight = 100
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get: () => {
                scrollHeight += 10
                return scrollHeight
            },
        })

        renderThread({
            hasMoreMessages: true,
            onLoadMore,
        })

        act(() => {
            for (let index = 0; index < 12; index += 1) {
                flushOneAnimationFrame()
            }
        })

        expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledTimes(12)
        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('restarts the initial bottom scroll when the session changes', () => {
        let scrollHeight = 1000
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        })
        const { rerender } = render(<HappyThread {...buildThreadProps({
            sessionId: 'session-1',
            messagesVersion: 1,
            rawMessagesCount: 3,
        })} />)

        act(() => {
            flushOneAnimationFrame()
            flushOneAnimationFrame()
            flushOneAnimationFrame()
        })

        scrollHeight = 2000
        rerender(<HappyThread {...buildThreadProps({
            sessionId: 'session-2',
            messagesVersion: 1,
            rawMessagesCount: 3,
        })} />)

        act(() => {
            flushOneAnimationFrame()
        })

        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: 'auto' })
    })
})
