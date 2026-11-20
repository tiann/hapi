import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

const searchTargetTestState = vi.hoisted(() => ({
    extras: undefined as unknown,
    renderMessages: (() => null) as () => ReactNode
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({ machines: [] })
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn()
}))

vi.mock('@/components/SessionHeader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/SessionHeader')>()
    return {
        ...actual,
        SessionHeader: () => null
    }
})

vi.mock('@/components/AssistantChat/HappyComposer', () => ({
    HappyComposer: () => null
}))

vi.mock('@/components/AssistantChat/QueuedMessagesBar', () => ({
    QueuedMessagesBar: () => null
}))

vi.mock('@assistant-ui/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@assistant-ui/react')>()
    return {
        ...actual,
        useAuiState: (selector: (state: unknown) => unknown) => selector({
            thread: { extras: searchTargetTestState.extras },
            composer: { text: '' }
        }),
        unstable_useThreadMessageIds: () => ['target-message'],
        ThreadPrimitive: {
            ...actual.ThreadPrimitive,
            Root: ({ children, className }: PropsWithChildren<{ className?: string }>) => (
                <div className={className}>{children}</div>
            ),
            Viewport: ({ children }: PropsWithChildren) => children,
            Messages: () => searchTargetTestState.renderMessages(),
            Unstable_MessageById: () => searchTargetTestState.renderMessages()
        }
    }
})

import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { SessionChat } from '@/components/SessionChat'
import { useConciseChatMode } from '@/hooks/useConciseChatMode'
import { useMessages } from '@/hooks/queries/useMessages'
import { clearMessageWindow, ingestIncomingMessages } from '@/lib/message-window-store'
import { configureSessionReadState, getSessionLastSeenAt, hasUnseenContent } from '@/lib/sessionLastSeen'
import type { ApiClient } from '@/api/client'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import type { DecryptedMessage, MessagesResponse, Session } from '@/types/api'

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
let resizeCallbacks: Array<() => void> = []

class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
    }

    observe() {}

    disconnect() {}
}

function renderThread(
    onViewModeChange = vi.fn(),
    unseenCount = 0,
    onJumpToTail?: () => void
) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    const renderHappyThread = (forceScrollToken: number) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <HappyThread
                    api={{ getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false }) } as unknown as ApiClient}
                    session={{ metadata: {} } as Session}
                    sessionId="mobile-scroll-session"
                    metadata={null}
                    disabled={false}
                    onRefresh={vi.fn()}
                    onViewModeChange={onViewModeChange}
                    onJumpToTail={onJumpToTail}
                    isSyncingTail={false}
                    messagesWarning={null}
                    hasMoreMessages={false}
                    isLoadingMoreMessages={false}
                    onLoadMore={vi.fn().mockResolvedValue({ status: 'exhausted' })}
                    onCancelLoadMore={vi.fn()}
                    unseenCount={unseenCount}
                    rawMessagesCount={1}
                    normalizedMessagesCount={1}
                    messagesVersion={1}
                    historyVersion={0}
                    forceScrollToken={forceScrollToken}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={vi.fn()}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
    const result = render(renderHappyThread(0))
    const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')
    if (!viewport) {
        throw new Error('Chat viewport was not rendered')
    }
    Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 1_232 },
        clientHeight: { configurable: true, value: 530 }
    })
    act(() => {
        vi.advanceTimersByTime(0)
    })
    return {
        ...result,
        viewport,
        onViewModeChange,
        rerenderThread: (forceScrollToken: number) => result.rerender(renderHappyThread(forceScrollToken))
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    resizeCallbacks = []
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: TestResizeObserver
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        writable: true,
        value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
            const requestedTop = typeof options === 'number' ? y ?? 0 : options.top ?? 0
            const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight)
            this.scrollTop = Math.min(Math.max(0, requestedTop), maxScrollTop)
        }
    })
})

afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    searchTargetTestState.extras = undefined
    searchTargetTestState.renderMessages = () => null
    if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
    } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
    if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
    if (originalResizeObserver) {
        Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver)
    } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
})

function renderSearchThread(options: {
    initialTargetMessageId?: string
    initialTargetMessageQuery?: string
    targetHighlightKind?: 'search' | 'pending-request'
    searchRequestId?: number
    onLoadMessageContext: (messageId: string) => Promise<boolean>
    onInitialTargetConsumed: () => void
    onSearchTargetDismissed?: () => void
    onViewModeChange?: (mode: 'tail' | 'history') => void
    messagesVersion: number
    historyVersion: number
    rawMessagesCount: number
}) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    const onViewModeChange = options.onViewModeChange ?? (() => {})
    const api = {
        getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false }),
        searchSessionContentMatches: vi.fn().mockResolvedValue({
            matches: options.initialTargetMessageId
                ? [{
                    messageId: options.initialTargetMessageId,
                    role: 'user' as const,
                    seq: 1,
                    createdAt: 1,
                    snippet: options.initialTargetMessageQuery ?? ''
                }]
                : [],
            total: options.initialTargetMessageId ? 1 : 0
        })
    } as unknown as ApiClient
    const renderHappyThread = (targetMessageId: string | null = options.initialTargetMessageId ?? null) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <HappyThread
                    api={api}
                    session={{ metadata: {} } as Session}
                    sessionId="search-target-session"
                    metadata={null}
                    disabled={false}
                    onRefresh={vi.fn()}
                    onViewModeChange={onViewModeChange}
                    isSyncingTail={false}
                    messagesWarning={null}
                    hasMoreMessages={true}
                    isLoadingMoreMessages={false}
                    onLoadMore={vi.fn().mockResolvedValue({ status: 'exhausted' })}
                    onCancelLoadMore={vi.fn()}
                    unseenCount={0}
                    rawMessagesCount={options.rawMessagesCount}
                    normalizedMessagesCount={options.rawMessagesCount}
                    messagesVersion={options.messagesVersion}
                    historyVersion={options.historyVersion}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={vi.fn()}
                    initialTargetMessageId={targetMessageId ?? undefined}
                    initialTargetMessageQuery={options.initialTargetMessageQuery}
                    targetHighlightKind={options.targetHighlightKind}
                    searchRequestId={options.searchRequestId}
                    onLoadMessageContext={options.onLoadMessageContext}
                    onInitialTargetConsumed={options.onInitialTargetConsumed}
                    onSearchTargetDismissed={options.onSearchTargetDismissed}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
    return { queryClient, renderHappyThread, onViewModeChange }
}

describe('mobile initial scroll settling', () => {
    it('shows the jump control during continuous upward scrolling and hides it at the bottom', () => {
        const { viewport, queryByRole } = renderThread()
        act(() => { vi.advanceTimersByTime(3_000) })
        viewport.scrollTop = 702
        fireEvent.scroll(viewport)
        expect(queryByRole('button', { name: /scroll to bottom/i })).toBeNull()

        viewport.scrollTop = 600
        fireEvent.scroll(viewport)
        expect(queryByRole('button', { name: /scroll to bottom/i })).not.toBeNull()
        viewport.scrollTop = 400
        fireEvent.scroll(viewport)
        expect(queryByRole('button', { name: /scroll to bottom/i })).not.toBeNull()

        viewport.scrollTop = 702
        fireEvent.scroll(viewport)
        expect(queryByRole('button', { name: /scroll to bottom/i })).toBeNull()
    })

    it('uses the explicit tail transition when a send requests a forced scroll', () => {
        const onViewModeChange = vi.fn()
        const onJumpToTail = vi.fn()
        const { rerenderThread } = renderThread(onViewModeChange, 0, onJumpToTail)
        onViewModeChange.mockClear()

        rerenderThread(1)

        expect(onJumpToTail).toHaveBeenCalledTimes(1)
        expect(onViewModeChange).not.toHaveBeenCalledWith('tail')
    })

    it('checks the final keyboard position before clearing intent at scrollend', () => {
        const { container, viewport } = renderThread()
        const sentinel = container.querySelector('.chat-scroll-content > [aria-hidden="true"]')!
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))
        fireEvent.keyDown(viewport, { key: 'Home' })
        fireEvent.keyUp(viewport, { key: 'Home' })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        viewport.scrollTop = 0
        fireEvent(viewport, new Event('scrollend'))
        act(() => {
            vi.advanceTimersByTime(1_800)
        })
        expect(viewport.scrollTop).toBe(0)
    })

    it.each([false, true])('keeps delayed keyboard intent only until scrollend (ended=%s)', (ended) => {
        const { container, viewport, onViewModeChange } = renderThread()
        const sentinel = container.querySelector('.chat-scroll-content > [aria-hidden="true"]')!
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        fireEvent.keyDown(viewport, { key: 'Home' })
        fireEvent.keyUp(viewport, { key: 'Home' })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        if (ended) fireEvent(viewport, new Event('scrollend'))
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(ended ? 702 : 520)
        if (!ended) expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('does not snap back after pointer cancellation ends a touch swipe', () => {
        const { viewport, onViewModeChange } = renderThread()
        expect(viewport.scrollTop).toBe(702)

        const pointerDown = new Event('pointerdown', { bubbles: true })
        Object.defineProperties(pointerDown, {
            button: { value: 0 },
            pointerType: { value: 'touch' }
        })
        fireEvent(viewport, pointerDown)
        const pointerCancel = new Event('pointercancel', { bubbles: true })
        Object.defineProperty(pointerCancel, 'pointerType', { value: 'touch' })
        fireEvent(viewport, pointerCancel)

        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(520)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('keeps settling for non-explicit non-zero layout movement', () => {
        const { viewport, onViewModeChange } = renderThread()

        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('does not snap back after a window-captured native scrollbar drag', () => {
        const { viewport, onViewModeChange } = renderThread()
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: 600
        } as DOMRect)

        fireEvent.mouseDown(window, { button: 0, clientX: 319, clientY: 200 })
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        fireEvent.mouseUp(window)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(520)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('ignores captured mouse input outside the chat viewport', () => {
        const { viewport, onViewModeChange } = renderThread()
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: 600
        } as DOMRect)

        fireEvent.mouseDown(window, { button: 0, clientX: 400, clientY: 200 })
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        fireEvent.mouseUp(window)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('keeps settling after the runtime resets the viewport to the exact top', () => {
        const { viewport, onViewModeChange } = renderThread()

        viewport.scrollTop = 0
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })
})

describe('explicit tail scrolling', () => {
    it('renders the unread count inside the compact bottom control', () => {
        const { container } = renderThread(vi.fn(), 7)
        const button = container.querySelector<HTMLButtonElement>('button[aria-label*="7"]')

        expect(button).not.toBeNull()
        expect(button).toHaveClass('rounded-full', 'h-6', 'w-6')
        expect(button).toHaveClass('bg-[var(--app-button)]', 'text-[var(--app-button-text)]')
        expect(button?.querySelector('span')).toHaveClass('translate-y-px')
        expect(button?.textContent).toContain('7')
    })

    it('uses the same smooth end-alignment scroll as outline navigation', () => {
        const scrollIntoView = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView
        })
        const { rerenderThread } = renderThread()

        rerenderThread(1)

        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' })
    })

    it('retargets the smooth tail jump when content grows during the animation', () => {
        const scrollIntoView = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView
        })
        const { rerenderThread } = renderThread()

        rerenderThread(1)
        expect(scrollIntoView).toHaveBeenCalledTimes(1)

        act(() => {
            resizeCallbacks.at(-1)?.()
        })

        expect(scrollIntoView).toHaveBeenCalledTimes(2)
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'end', behavior: 'smooth' })
    })

    it('stays in tail mode through smooth-scroll progress and content growth', () => {
        const { viewport, onViewModeChange, rerenderThread } = renderThread()
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        viewport.scrollTop = 400
        fireEvent.scroll(viewport)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')

        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: vi.fn()
        })
        onViewModeChange.mockClear()
        rerenderThread(1)
        expect(onViewModeChange).toHaveBeenLastCalledWith('tail')

        viewport.scrollTop = 500
        fireEvent.scroll(viewport)
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_400 })
        viewport.scrollTop = 650
        fireEvent.scroll(viewport)

        expect(onViewModeChange).not.toHaveBeenCalledWith('history')

        viewport.scrollTop = 870
        fireEvent.scroll(viewport)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })
})

describe('search target loading', () => {
    it('keeps both navigation arrows active for a single result and re-jumps to it', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">target</div>
        )

        const { queryClient, renderHappyThread } = renderSearchThread({
            initialTargetMessageId: 'target-message',
            initialTargetMessageQuery: 'target',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        })
        const result = render(renderHappyThread())
        act(() => {
            queryClient.setQueryData(queryKeys.sessionContentSearch('search-target-session', 'target'), {
                matches: [{
                    messageId: 'target-message',
                    role: 'user' as const,
                    seq: 1,
                    createdAt: 1,
                    snippet: 'target'
                }],
                total: 1
            })
            result.rerender(renderHappyThread())
        })

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })
        const previous = result.getByRole('button', { name: 'Previous match' })
        expect(previous).not.toBeDisabled()
        const next = result.getByRole('button', { name: 'Next match' })
        expect(next).not.toBeDisabled()
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)

        fireEvent.click(previous)
        await act(async () => {
            await Promise.resolve()
        })
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(2)

        fireEvent.click(next)
        await act(async () => {
            await Promise.resolve()
        })
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(3)
    })

    it('waits for assistant-ui to apply the current message window before anchoring', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">stale target</div>
        )

        const options = {
            initialTargetMessageId: 'target-message',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 2,
            historyVersion: 0,
            rawMessagesCount: 1
        }
        const { renderHappyThread } = renderSearchThread(options)
        const result = render(renderHappyThread())

        expect(result.container.querySelector('[data-testid="search-target-status"]')?.textContent)
            .toContain('Locating message')
        expect(onLoadMessageContext).not.toHaveBeenCalled()
        expect(onInitialTargetConsumed).not.toHaveBeenCalled()

        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 0 }
        await act(async () => {
            result.rerender(renderHappyThread())
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)
        expect(result.container.querySelector('[data-testid="search-target-status"]')).not.toBeInTheDocument()
    })

    it('refreshes cached server context before anchoring an already-rendered target', async () => {
        let resolveContext: ((loaded: boolean) => void) | undefined
        const onLoadMessageContext = vi.fn(() => new Promise<boolean>((resolve) => {
            resolveContext = resolve
        }))
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">cached target</div>
        )

        const { renderHappyThread } = renderSearchThread({
            initialTargetMessageId: 'target-message',
            searchRequestId: 7,
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        })
        render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
        })

        expect(onLoadMessageContext).toHaveBeenCalledWith('target-message')
        expect(onInitialTargetConsumed).not.toHaveBeenCalled()

        await act(async () => {
            resolveContext?.(true)
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)
    })

    it('uses the transient pending-request highlight for a tool-card target', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <details>
                <summary>Collapsed details</summary>
                <div id="hapi-message-tool-call:call-1" data-hapi-source-message-id="tool-call:call-1">tool card</div>
            </details>
        )

        const { renderHappyThread } = renderSearchThread({
            initialTargetMessageId: 'tool-call:call-1',
            targetHighlightKind: 'pending-request',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1,
        })
        const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo')
        const result = render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
        result.rerender(renderHappyThread(null))
        scrollTo.mockClear()
        act(() => {
            for (const callback of resizeCallbacks) callback()
        })
        expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }))
        const target = result.container.querySelector<HTMLElement>('[data-hapi-source-message-id="tool-call:call-1"]')
        expect(result.container.querySelector('details')).toHaveProperty('open', true)
        expect(target).toHaveClass('hapi-message-pending-target')
        expect(target).not.toHaveClass('hapi-message-search-target')
        act(() => { vi.advanceTimersByTime(1_800) })
        expect(target).not.toHaveClass('hapi-message-pending-target')
    })

    it('navigates a synthesized pending card without loading transcript context', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(false)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="tool-call:cursor-question">synthesized question</div>
        )

        const { renderHappyThread } = renderSearchThread({
            initialTargetMessageId: 'tool-call:cursor-question',
            targetHighlightKind: 'pending-request',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1,
        })
        const result = render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
        })

        const target = result.container.querySelector<HTMLElement>('[data-hapi-source-message-id="tool-call:cursor-question"]')
        expect(target).toHaveClass('hapi-message-pending-target')
        expect(onLoadMessageContext).not.toHaveBeenCalled()
        expect(onInitialTargetConsumed).toHaveBeenCalledOnce()
    })
    it('clears a fallback card highlight when the search target is dismissed', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">target card</div>
        )

        const options = {
            initialTargetMessageId: 'target-message' as string | undefined,
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1,
        }
        const { renderHappyThread } = renderSearchThread(options)
        const result = render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
        })

        const target = result.container.querySelector<HTMLElement>('[data-hapi-source-message-id="target-message"]')
        expect(target).toHaveClass('hapi-message-search-target')
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)

        options.initialTargetMessageId = undefined
        options.messagesVersion = 2
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 0 }
        act(() => {
            result.rerender(renderHappyThread())
        })

        expect(target).not.toHaveClass('hapi-message-search-target')
    })

    it('visibly highlights a markdown match spanning rendered text nodes', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">
                KV <strong>Cache</strong>
            </div>
        )

        const { renderHappyThread } = renderSearchThread({
            initialTargetMessageId: 'target-message',
            initialTargetMessageQuery: 'KV Cache',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        })
        const result = render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
        })

        const markers = result.container.querySelectorAll<HTMLElement>(
            '[data-hapi-source-search-match="true"]'
        )
        expect(markers.length).toBeGreaterThan(1)
        expect(Array.from(markers).map((marker) => marker.textContent).join(''))
            .toContain('KV Cache')
        expect(result.container.querySelector('strong [data-hapi-source-search-match="true"]'))
            .toBeInTheDocument()
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)
    })

    it('loads context after the runtime catches up when the target is not in the latest window', () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => null

        const options = {
            initialTargetMessageId: 'target-message',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 2,
            historyVersion: 0,
            rawMessagesCount: 1
        }
        const { renderHappyThread } = renderSearchThread(options)
        const result = render(renderHappyThread())

        expect(onLoadMessageContext).not.toHaveBeenCalled()

        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 0 }
        act(() => {
            result.rerender(renderHappyThread())
        })

        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)
        expect(onInitialTargetConsumed).not.toHaveBeenCalled()
    })

    it('waits for assistant-ui to render a loaded context instead of requesting it again', async () => {
        let resolveContext: ((loaded: boolean) => void) | undefined
        const onLoadMessageContext = vi.fn(() => new Promise<boolean>((resolve) => {
            resolveContext = resolve
        }))
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => null

        const options = {
            initialTargetMessageId: 'target-message',
            initialTargetMessageQuery: 'cache',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        }
        const { renderHappyThread } = renderSearchThread(options)
        const result = render(renderHappyThread())

        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)
        expect(resolveContext).toBeDefined()

        await act(async () => {
            resolveContext?.(true)
            await Promise.resolve()
        })

        result.rerender(renderHappyThread())
        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)
        expect(onInitialTargetConsumed).not.toHaveBeenCalled()

        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">cache hit</div>
        )
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 1 }
        options.messagesVersion = 2
        options.historyVersion = 1
        options.rawMessagesCount = 3
        act(() => {
            result.rerender(renderHappyThread())
        })

        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)
        expect(result.container.querySelector('[data-hapi-source-search-match="true"]')).toBeInTheDocument()
    })

    it('does not let a later initial render reset a consumed historical jump to tail', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        const onViewModeChange = vi.fn<(mode: 'tail' | 'history') => void>()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => null

        const options = {
            initialTargetMessageId: 'target-message' as string | undefined,
            onLoadMessageContext,
            onInitialTargetConsumed,
            onViewModeChange,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        }
        const { renderHappyThread } = renderSearchThread(options)
        const result = render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
        })
        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">target</div>
        )
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 1 }
        options.messagesVersion = 2
        options.historyVersion = 1
        options.rawMessagesCount = 2
        act(() => {
            result.rerender(renderHappyThread())
        })
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)

        onViewModeChange.mockClear()
        options.initialTargetMessageId = undefined
        options.messagesVersion = 3
        act(() => {
            result.rerender(renderHappyThread())
        })

        expect(onViewModeChange).not.toHaveBeenCalledWith('tail')
    })

    it('retries a transient context rejection without clearing the route target', async () => {
        const onLoadMessageContext = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => null

        const options = {
            initialTargetMessageId: 'target-message',
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        }
        const { renderHappyThread } = renderSearchThread(options)
        const result = render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)
        expect(onInitialTargetConsumed).not.toHaveBeenCalled()

        act(() => {
            vi.advanceTimersByTime(75)
        })
        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMessageContext).toHaveBeenCalledTimes(2)
        expect(onInitialTargetConsumed).not.toHaveBeenCalled()

        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">target</div>
        )
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 1 }
        options.messagesVersion = 2
        options.historyVersion = 1
        options.rawMessagesCount = 2
        act(() => {
            result.rerender(renderHappyThread())
        })

        expect(onLoadMessageContext).toHaveBeenCalledTimes(2)
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)
    })

    it('dismisses the route target after terminal context-load failure', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(false)
        const onInitialTargetConsumed = vi.fn()
        const onSearchTargetDismissed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => null

        const options = {
            initialTargetMessageId: 'target-message',
            onLoadMessageContext,
            onInitialTargetConsumed,
            onSearchTargetDismissed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        }
        const { renderHappyThread } = renderSearchThread(options)
        render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)

        for (let attempt = 0; attempt < 3; attempt += 1) {
            act(() => {
                vi.advanceTimersByTime(75)
            })
            await act(async () => {
                await Promise.resolve()
            })
        }

        expect(onLoadMessageContext).toHaveBeenCalledTimes(4)
        expect(onSearchTargetDismissed).toHaveBeenCalledTimes(1)
        expect(onInitialTargetConsumed).not.toHaveBeenCalled()
    })

    it('resets a consumed target so the same result can be opened again', async () => {
        const onLoadMessageContext = vi.fn().mockResolvedValue(true)
        const onInitialTargetConsumed = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => null

        const options = {
            initialTargetMessageId: 'target-message' as string | undefined,
            searchRequestId: undefined as number | undefined,
            onLoadMessageContext,
            onInitialTargetConsumed,
            messagesVersion: 1,
            historyVersion: 0,
            rawMessagesCount: 1
        }
        const { renderHappyThread } = renderSearchThread(options)
        const result = render(renderHappyThread())

        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMessageContext).toHaveBeenCalledTimes(1)

        searchTargetTestState.renderMessages = () => (
            <div data-hapi-source-message-id="target-message">target</div>
        )
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 1 }
        options.messagesVersion = 2
        options.historyVersion = 1
        options.rawMessagesCount = 2
        act(() => {
            result.rerender(renderHappyThread())
        })
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)

        options.searchRequestId = 1
        searchTargetTestState.renderMessages = () => null
        searchTargetTestState.extras = { messagesVersion: 3, historyVersion: 2 }
        options.messagesVersion = 3
        options.historyVersion = 2
        act(() => {
            result.rerender(renderHappyThread())
        })

        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMessageContext).toHaveBeenCalledTimes(2)
    })
})
describe('tail following survives layout-driven movement', () => {
    it('re-pins to the tail when content grows without a user gesture', () => {
        const { viewport, onViewModeChange } = renderThread()
        act(() => {
            vi.advanceTimersByTime(1_800)
        })
        expect(viewport.scrollTop).toBe(702)

        // Streaming assistant output grows the transcript while the viewport
        // sits still, so distanceFromBottom increases without any scroll input.
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_400 })
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(0)
        })

        expect(viewport.scrollTop).toBe(870)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('re-pins to the tail when the mobile keyboard shrinks the viewport', () => {
        const { viewport, onViewModeChange } = renderThread()
        act(() => {
            vi.advanceTimersByTime(1_800)
        })
        expect(viewport.scrollTop).toBe(702)

        // Opening the keyboard shortens the visual viewport; the browser
        // reports a scroll without any upward gesture from the user.
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 })
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(0)
        })

        expect(viewport.scrollTop).toBe(832)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })
})

type SwitchThreadProps = {
    sessionId: string
    isSyncingTail: boolean
    hasMoreMessages: boolean
    rawMessagesCount: number
    messagesVersion: number
    historyVersion: number
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onViewModeChange: (mode: 'tail' | 'history') => void
    keyBySession?: boolean
}

function createSwitchThreadRenderer(initialProps: SwitchThreadProps) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    const api = {
        getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false })
    } as unknown as ApiClient
    const buildElement = (props: SwitchThreadProps) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <HappyThread
                    key={props.keyBySession ? props.sessionId : undefined}
                    api={api}
                    session={{ metadata: {} } as Session}
                    sessionId={props.sessionId}
                    metadata={null}
                    disabled={false}
                    onRefresh={vi.fn()}
                    onViewModeChange={props.onViewModeChange}
                    isSyncingTail={props.isSyncingTail}
                    messagesWarning={null}
                    hasMoreMessages={props.hasMoreMessages}
                    isLoadingMoreMessages={false}
                    onLoadMore={props.onLoadMore}
                    onCancelLoadMore={vi.fn()}
                    unseenCount={0}
                    rawMessagesCount={props.rawMessagesCount}
                    normalizedMessagesCount={props.rawMessagesCount}
                    messagesVersion={props.messagesVersion}
                    historyVersion={props.historyVersion}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={vi.fn()}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
    const result = render(buildElement(initialProps))
    const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')
    const sentinel = result.container.querySelector<HTMLElement>('.chat-scroll-content > [aria-hidden="true"]')
    if (!viewport || !sentinel) {
        throw new Error('Chat viewport or sentinel was not rendered')
    }
    return {
        ...result,
        viewport,
        sentinel,
        rerenderWith: (nextProps: SwitchThreadProps) => result.rerender(buildElement(nextProps))
    }
}

describe('session switch tail anchoring', () => {
    it('fills an uncovered initial tail immediately and keeps tail pinned through prepend and async resize', async () => {
        let resolveLoadMore!: (outcome: OlderLoadOutcome) => void
        let pendingOnBeforeApply: ((historyVersion: number) => boolean) | undefined
        const onLoadMore = vi.fn((onBeforeApply?: (historyVersion: number) => boolean) => {
            pendingOnBeforeApply = onBeforeApply
            return new Promise<OlderLoadOutcome>((resolve) => {
                resolveLoadMore = resolve
            })
        })
        const onViewModeChange = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }

        const props: SwitchThreadProps = {
            sessionId: 'session-uncovered',
            isSyncingTail: false,
            hasMoreMessages: true,
            rawMessagesCount: 20,
            messagesVersion: 1,
            historyVersion: 0,
            onLoadMore,
            onViewModeChange,
            keyBySession: true
        }
        const { viewport, sentinel, rerenderWith, queryByRole } = createSwitchThreadRenderer(props)
        let scrollHeight = 320
        const clientHeight = 530
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, value: clientHeight }
        })
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: clientHeight } as DOMRect)
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        // Trigger initial layout resize once viewport geometry is measured; should start
        // older coverage immediately without waiting 1,800ms.
        act(() => {
            resizeCallbacks.at(-1)?.()
        })
        expect(onLoadMore).toHaveBeenCalledTimes(1)

        await act(async () => {
            expect(pendingOnBeforeApply?.(1)).toBe(true)
            resolveLoadMore({ kind: 'applied', historyVersion: 1, hasMore: true, addedRenderableCount: 20 })
            await Promise.resolve()
        })

        scrollHeight = 2_400
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 1 }
        act(() => {
            rerenderWith({ ...props, messagesVersion: 2, historyVersion: 1 })
        })
        expect(viewport.scrollTop).toBe(1_870)

        // Subsequent async height growth in the prepended older messages (markdown/code/images)
        // must keep the viewport pinned to the newest tail.
        scrollHeight = 2_900
        fireEvent.scroll(viewport)
        act(() => {
            resizeCallbacks.at(-1)?.()
            vi.advanceTimersByTime(3_000)
        })

        expect(viewport.scrollTop).toBe(2_370)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
        expect(queryByRole('button', { name: /scroll to bottom/i })).toBeNull()
    })

    it('does not trigger coverage loads while pinned at bottom within the 200px preload margin', () => {
        const onLoadMore = vi.fn().mockResolvedValue({ kind: 'stopped', reason: 'exhausted' } satisfies OlderLoadOutcome)
        const onViewModeChange = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }

        const props: SwitchThreadProps = {
            sessionId: 'session-filled-margin',
            isSyncingTail: false,
            hasMoreMessages: true,
            rawMessagesCount: 20,
            messagesVersion: 1,
            historyVersion: 0,
            onLoadMore,
            onViewModeChange,
            keyBySession: true
        }
        const { viewport, sentinel, queryByRole } = createSwitchThreadRenderer(props)
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, value: 680 },
            clientHeight: { configurable: true, value: 530 }
        })
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 530 } as DOMRect)
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        act(() => {
            viewport.scrollTop = 150
            resizeCallbacks.at(-1)?.()
            vi.advanceTimersByTime(3_000)
        })

        expect(onLoadMore).not.toHaveBeenCalled()
        expect(viewport.scrollTop).toBe(150)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
        expect(queryByRole('button', { name: /scroll to bottom/i })).toBeNull()

        fireEvent.wheel(viewport, { deltaY: -100 })
        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('waits for assistant-ui runtime extras to catch up before arming initial tail settling', () => {
        const onLoadMore = vi.fn().mockResolvedValue({ kind: 'stopped', reason: 'exhausted' } satisfies OlderLoadOutcome)
        const onViewModeChange = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }

        const propsA: SwitchThreadProps = {
            sessionId: 'session-deferred-a',
            isSyncingTail: false,
            hasMoreMessages: false,
            rawMessagesCount: 5,
            messagesVersion: 1,
            historyVersion: 0,
            onLoadMore,
            onViewModeChange
        }
        const { viewport, rerenderWith } = createSwitchThreadRenderer(propsA)
        let scrollHeight = 530
        const clientHeight = 530
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, value: clientHeight }
        })
        act(() => {
            vi.advanceTimersByTime(2_000)
        })
        expect(viewport.scrollTop).toBe(0)

        // Session switches and messagesVersion increments to 2, while assistant-ui
        // still renders stale DOM (extras.messagesVersion === 1).
        const propsB: SwitchThreadProps = {
            ...propsA,
            sessionId: 'session-deferred-b',
            rawMessagesCount: 20,
            messagesVersion: 2
        }
        act(() => {
            rerenderWith(propsB)
            vi.advanceTimersByTime(2_000)
        })

        // One passive effect later, assistant-ui applies messagesVersion 2 and
        // mounts the taller transcript. Initial settling must now scroll to the bottom.
        scrollHeight = 1_600
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 0 }
        act(() => {
            rerenderWith(propsB)
        })
        expect(viewport.scrollTop).toBe(1_070)

        act(() => {
            vi.advanceTimersByTime(2_000)
        })
        expect(viewport.scrollTop).toBe(1_070)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('re-pins non-explicit scroll movement during isSyncingTail while preserving explicit upward scrolls', () => {
        const onLoadMore = vi.fn().mockResolvedValue({ kind: 'stopped', reason: 'exhausted' } satisfies OlderLoadOutcome)
        const onViewModeChangeA = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }

        const propsA: SwitchThreadProps = {
            sessionId: 'session-cached-nonexplicit',
            isSyncingTail: true,
            hasMoreMessages: false,
            rawMessagesCount: 20,
            messagesVersion: 1,
            historyVersion: 0,
            onLoadMore,
            onViewModeChange: onViewModeChangeA,
            keyBySession: true
        }
        const first = createSwitchThreadRenderer(propsA)
        Object.defineProperties(first.viewport, {
            scrollHeight: { configurable: true, value: 1_232 },
            clientHeight: { configurable: true, value: 530 }
        })
        first.viewport.scrollTop = 702
        fireEvent.scroll(first.viewport)

        first.viewport.scrollTop = 520
        fireEvent.scroll(first.viewport)
        expect(first.viewport.scrollTop).toBe(702)
        expect(onViewModeChangeA).not.toHaveBeenCalledWith('history')
        expect(first.queryByRole('button', { name: /scroll to bottom/i })).toBeNull()

        cleanup()
        const onViewModeChangeB = vi.fn()
        const propsB: SwitchThreadProps = {
            ...propsA,
            sessionId: 'session-cached-explicit',
            onViewModeChange: onViewModeChangeB
        }
        const second = createSwitchThreadRenderer(propsB)
        Object.defineProperties(second.viewport, {
            scrollHeight: { configurable: true, value: 1_232 },
            clientHeight: { configurable: true, value: 530 }
        })
        vi.spyOn(second.viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: 530
        } as DOMRect)
        second.viewport.scrollTop = 702
        fireEvent.scroll(second.viewport)

        const pointerDown = new Event('pointerdown', { bubbles: true })
        Object.defineProperty(pointerDown, 'button', { value: 0 })
        fireEvent(second.viewport, pointerDown)
        second.viewport.scrollTop = 450
        fireEvent.scroll(second.viewport)
        fireEvent.pointerUp(window)

        expect(second.viewport.scrollTop).toBe(450)
        expect(onViewModeChangeB).toHaveBeenLastCalledWith('history')

        onViewModeChangeB.mockClear()
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 0 }
        act(() => {
            second.rerenderWith({
                ...propsB,
                isSyncingTail: false,
                messagesVersion: 2
            })
            vi.advanceTimersByTime(2_000)
        })

        expect(second.viewport.scrollTop).toBe(450)
        expect(onViewModeChangeB).not.toHaveBeenCalledWith('tail')
    })

    it('preserves the bottom edge of the first card when an older prepend merges into and grows it', async () => {
        let resolveLoadMore!: (outcome: OlderLoadOutcome) => void
        let pendingOnBeforeApply: ((historyVersion: number) => boolean) | undefined
        const onLoadMore = vi.fn((onBeforeApply?: (historyVersion: number) => boolean) => {
            pendingOnBeforeApply = onBeforeApply
            return new Promise<OlderLoadOutcome>((resolve) => {
                resolveLoadMore = resolve
            })
        })
        const onViewModeChange = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        searchTargetTestState.renderMessages = () => (
            <div id="hapi-message-tool-group:tg-1">merged tools</div>
        )

        const props: SwitchThreadProps = {
            sessionId: 'session-card-growth',
            isSyncingTail: false,
            hasMoreMessages: true,
            rawMessagesCount: 20,
            messagesVersion: 1,
            historyVersion: 0,
            onLoadMore,
            onViewModeChange,
            keyBySession: true
        }
        const { container, viewport, sentinel, rerenderWith } = createSwitchThreadRenderer(props)
        let scrollHeight = 2_000
        const clientHeight = 530
        let cardDocTop = 12
        let cardHeight = 120
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, value: clientHeight }
        })
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: clientHeight
        } as DOMRect)
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))
        const card = container.querySelector<HTMLElement>('#hapi-message-tool-group\\:tg-1')!
        vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => ({
            top: cardDocTop - viewport.scrollTop,
            bottom: cardDocTop + cardHeight - viewport.scrollTop,
            height: cardHeight
        } as DOMRect))

        act(() => {
            vi.advanceTimersByTime(3_000)
        })
        expect(viewport.scrollTop).toBe(1_470)

        fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 })
        viewport.scrollTop = 0
        fireEvent.scroll(viewport)
        fireEvent.pointerUp(window)
        expect(onLoadMore).toHaveBeenCalledTimes(1)

        await act(async () => {
            expect(pendingOnBeforeApply?.(1)).toBe(true)
            resolveLoadMore({ kind: 'applied', historyVersion: 1, hasMore: true, addedRenderableCount: 50 })
            await Promise.resolve()
        })

        // Prepended rows push the first card down by 900px AND merge older tools
        // into the top of the card, growing its height from 120px to 420px.
        scrollHeight = 3_200
        cardDocTop = 912
        cardHeight = 420
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 1 }
        act(() => {
            rerenderWith({ ...props, messagesVersion: 2, historyVersion: 1 })
        })

        // Bottom edge was at 132px; after prepending it must stay at 132px
        // (scrollTop = 912 + 420 - 132 = 1200) rather than aligning the new top
        // (scrollTop = 900) and jumping 300px upward.
        expect(viewport.scrollTop).toBe(1_200)
    })

    it('defers automatic coverage loads until runtime extras commit initial tail messages', () => {
        const onLoadMore = vi.fn().mockResolvedValue({ kind: 'stopped', reason: 'exhausted' } satisfies OlderLoadOutcome)
        const onViewModeChange = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 0, historyVersion: 0 }

        const initialProps: SwitchThreadProps = {
            sessionId: 'session-pre-runtime-commit',
            isSyncingTail: true,
            hasMoreMessages: false,
            rawMessagesCount: 0,
            messagesVersion: 0,
            historyVersion: 0,
            onLoadMore,
            onViewModeChange,
            keyBySession: true
        }
        const { viewport, sentinel, rerenderWith } = createSwitchThreadRenderer(initialProps)
        let scrollHeight = 600
        const clientHeight = 600
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, value: clientHeight }
        })
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: clientHeight } as DOMRect)
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        // Tail sync finishes with 20 messages (messagesVersion = 1), while
        // assistant-ui still renders stale empty DOM (extras.messagesVersion = 0).
        const loadedProps: SwitchThreadProps = {
            ...initialProps,
            isSyncingTail: false,
            hasMoreMessages: true,
            rawMessagesCount: 20,
            messagesVersion: 1
        }
        act(() => {
            rerenderWith(loadedProps)
            resizeCallbacks.at(-1)?.()
            vi.advanceTimersByTime(2_000)
        })
        expect(onLoadMore).not.toHaveBeenCalled()

        // Once runtime extras commit the initial page (overflow = 120px < 200px),
        // HappyThread pins to the bottom and must not trigger a coverage prepend.
        scrollHeight = 720
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        act(() => {
            rerenderWith(loadedProps)
            resizeCallbacks.at(-1)?.()
            vi.advanceTimersByTime(3_000)
        })
        expect(viewport.scrollTop).toBe(120)
        expect(onLoadMore).not.toHaveBeenCalled()
    })

    it('preserves tail following after an upward wheel on a short exhausted conversation when streaming grows content', () => {
        const onLoadMore = vi.fn().mockResolvedValue({ kind: 'stopped', reason: 'exhausted' } satisfies OlderLoadOutcome)
        const onViewModeChange = vi.fn()
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }

        const initialProps: SwitchThreadProps = {
            sessionId: 'session-short-exhausted-wheel',
            isSyncingTail: false,
            hasMoreMessages: false,
            rawMessagesCount: 2,
            messagesVersion: 1,
            historyVersion: 0,
            onLoadMore,
            onViewModeChange,
            keyBySession: true
        }
        const { viewport, sentinel, rerenderWith, queryByRole } = createSwitchThreadRenderer(initialProps)
        let scrollHeight = 300
        const clientHeight = 530
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, value: clientHeight }
        })
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: clientHeight } as DOMRect)
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        act(() => {
            vi.advanceTimersByTime(2_000)
        })

        // Upward wheel on a short, exhausted conversation cannot scroll or load
        // older history; it must not silently break tail-following.
        fireEvent.wheel(viewport, { deltaY: -120 })
        expect(onLoadMore).not.toHaveBeenCalled()
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')

        // Subsequent streaming output grows beyond the viewport; HappyThread must
        // stay pinned to the bottom without rendering a jump-to-bottom button.
        scrollHeight = 1_200
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 0 }
        act(() => {
            rerenderWith({
                ...initialProps,
                messagesVersion: 2
            })
            resizeCallbacks.at(-1)?.()
        })

        expect(viewport.scrollTop).toBe(670)
        expect(queryByRole('button', { name: /scroll to bottom/i })).toBeNull()
    })
})

describe('cached re-entry tail-sync indicator', () => {
    function renderCatchUpThread(options: { isCatchingUpFromCache: boolean; rawMessagesCount: number }) {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        return render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <HappyThread
                        api={{ getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false }) } as unknown as ApiClient}
                        session={{ metadata: {} } as Session}
                        sessionId="catch-up-session"
                        metadata={null}
                        disabled={false}
                        onRefresh={vi.fn()}
                        onViewModeChange={vi.fn()}
                        isSyncingTail={options.isCatchingUpFromCache}
                        isCatchingUpFromCache={options.isCatchingUpFromCache}
                        messagesWarning={null}
                        hasMoreMessages={false}
                        isLoadingMoreMessages={false}
                        onLoadMore={vi.fn().mockResolvedValue({ status: 'exhausted' })}
                        onCancelLoadMore={vi.fn()}
                        unseenCount={0}
                        rawMessagesCount={options.rawMessagesCount}
                        normalizedMessagesCount={options.rawMessagesCount}
                        messagesVersion={1}
                        historyVersion={0}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={vi.fn()}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )
    }

    const queryIndicator = (container: HTMLElement) =>
        container.querySelector<HTMLElement>('[data-testid="tail-sync-status"]')

    it('shows the fetching-latest pill over stale cached rows during re-entry', () => {
        const { container } = renderCatchUpThread({ isCatchingUpFromCache: true, rawMessagesCount: 3 })
        act(() => {
            vi.advanceTimersByTime(0)
        })
        const pill = queryIndicator(container)
        expect(pill).not.toBeNull()
        expect(pill?.getAttribute('role')).toBe('status')
        expect((pill?.textContent ?? '').trim().length).toBeGreaterThan(0)
    })

    it('hides the pill once the catch-up fetch settles', () => {
        const { container } = renderCatchUpThread({ isCatchingUpFromCache: false, rawMessagesCount: 3 })
        act(() => {
            vi.advanceTimersByTime(0)
        })
        expect(queryIndicator(container)).toBeNull()
    })

    it('never shows the pill for an empty window (the skeleton covers it)', () => {
        const { container } = renderCatchUpThread({ isCatchingUpFromCache: true, rawMessagesCount: 0 })
        act(() => {
            vi.advanceTimersByTime(0)
        })
        expect(queryIndicator(container)).toBeNull()
    })
})

describe('concise view history coverage', () => {
    it('immediately pages older history across tool-only pages when switching sessions in concise view', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        const api = {
            getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false })
        } as unknown as ApiClient

        const state = {
            sessionId: 'concise-session-b',
            isSyncingTail: false,
            hasMoreMessages: true,
            isLoadingMoreMessages: false,
            rawMessagesCount: 20,
            normalizedMessagesCount: 20,
            visibleBlocksCount: 0,
            conciseViewActive: true,
            messagesVersion: 1,
            historyVersion: 0
        }

        const onLoadMore = vi.fn().mockImplementation(async (onBeforeApply?: (historyVersion: number) => boolean) => {
            const nextHistoryVersion = state.historyVersion + 1
            onBeforeApply?.(nextHistoryVersion)
            return {
                kind: 'applied' as const,
                historyVersion: nextHistoryVersion,
                hasMore: true,
                addedRenderableCount: 200
            }
        })

        const renderConciseThread = () => (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <HappyThread
                        api={api}
                        session={{ metadata: {} } as Session}
                        sessionId={state.sessionId}
                        metadata={null}
                        disabled={false}
                        onRefresh={vi.fn()}
                        onViewModeChange={vi.fn()}
                        isSyncingTail={state.isSyncingTail}
                        messagesWarning={null}
                        hasMoreMessages={state.hasMoreMessages}
                        isLoadingMoreMessages={state.isLoadingMoreMessages}
                        onLoadMore={onLoadMore}
                        onCancelLoadMore={vi.fn()}
                        unseenCount={0}
                        rawMessagesCount={state.rawMessagesCount}
                        normalizedMessagesCount={state.normalizedMessagesCount}
                        visibleBlocksCount={state.visibleBlocksCount}
                        conciseViewActive={state.conciseViewActive}
                        messagesVersion={state.messagesVersion}
                        historyVersion={state.historyVersion}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={vi.fn()}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )

        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        const result = render(renderConciseThread())
        const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')!
        const sentinel = result.container.querySelector<HTMLElement>('.chat-scroll-content > [aria-hidden="true"]')!
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, value: 530 },
            clientHeight: { configurable: true, value: 530 }
        })
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        await act(async () => {
            await Promise.resolve()
        })

        // First older page fires immediately without waiting for the 1,800ms initial scroll settle timer.
        expect(onLoadMore).toHaveBeenCalledTimes(1)

        // Page 1 finishes with 200 raw tool/reasoning messages that are still 100% filtered in concise view.
        state.rawMessagesCount = 220
        state.normalizedMessagesCount = 220
        state.visibleBlocksCount = 0
        state.historyVersion = 1
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 1 }
        act(() => {
            result.rerender(renderConciseThread())
        })
        act(() => {
            vi.advanceTimersByTime(0)
        })
        await act(async () => {
            await Promise.resolve()
        })

        // Loader does not auto-pause on an empty concise view; it automatically chains page 2.
        expect(onLoadMore).toHaveBeenCalledTimes(2)

        // Page 2 reveals 12 visible conversation blocks that cover the viewport and pin to the bottom.
        state.rawMessagesCount = 420
        state.normalizedMessagesCount = 420
        state.visibleBlocksCount = 12
        state.historyVersion = 2
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 2 }
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_400 })
        act(() => {
            result.rerender(renderConciseThread())
        })
        act(() => {
            vi.advanceTimersByTime(50)
        })
        await act(async () => {
            await Promise.resolve()
        })

        expect(viewport.scrollTop).toBe(870)
        expect(onLoadMore).toHaveBeenCalledTimes(2)
    })

    it('re-arms automatic coverage when toggling concise view on collapses the thread', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        const api = {
            getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false })
        } as unknown as ApiClient

        const state = {
            hasMoreMessages: true,
            isLoadingMoreMessages: false,
            rawMessagesCount: 200,
            normalizedMessagesCount: 200,
            visibleBlocksCount: 200,
            conciseViewActive: false,
            messagesVersion: 1,
            historyVersion: 0
        }

        const onLoadMore = vi.fn().mockImplementation(async (onBeforeApply?: (historyVersion: number) => boolean) => {
            const nextHistoryVersion = state.historyVersion + 1
            onBeforeApply?.(nextHistoryVersion)
            return {
                kind: 'applied' as const,
                historyVersion: nextHistoryVersion,
                hasMore: true,
                addedRenderableCount: 200
            }
        })

        const renderToggleThread = () => (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <HappyThread
                        api={api}
                        session={{ metadata: {} } as Session}
                        sessionId="concise-toggle-session"
                        metadata={null}
                        disabled={false}
                        onRefresh={vi.fn()}
                        onViewModeChange={vi.fn()}
                        isSyncingTail={false}
                        messagesWarning={null}
                        hasMoreMessages={state.hasMoreMessages}
                        isLoadingMoreMessages={state.isLoadingMoreMessages}
                        onLoadMore={onLoadMore}
                        onCancelLoadMore={vi.fn()}
                        unseenCount={0}
                        rawMessagesCount={state.rawMessagesCount}
                        normalizedMessagesCount={state.normalizedMessagesCount}
                        visibleBlocksCount={state.visibleBlocksCount}
                        conciseViewActive={state.conciseViewActive}
                        messagesVersion={state.messagesVersion}
                        historyVersion={state.historyVersion}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={vi.fn()}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )

        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        const result = render(renderToggleThread())
        const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')!
        const sentinel = result.container.querySelector<HTMLElement>('.chat-scroll-content > [aria-hidden="true"]')!
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, value: 530 },
            clientHeight: { configurable: true, value: 530 }
        })
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        // First page in normal mode loads and sets autoPaused = true.
        act(() => {
            vi.advanceTimersByTime(2_000)
        })
        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMore).toHaveBeenCalledTimes(1)

        state.historyVersion = 1
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 1 }
        act(() => {
            result.rerender(renderToggleThread())
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })
        expect(onLoadMore).toHaveBeenCalledTimes(1)

        // Enabling concise mode hides tool/reasoning blocks, leaving 0 visible blocks;
        // autoPaused is cleared and older history loads automatically without scrolling.
        state.conciseViewActive = true
        state.visibleBlocksCount = 0
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 530 })
        act(() => {
            result.rerender(renderToggleThread())
        })
        await act(async () => {
            await Promise.resolve()
        })

        expect(onLoadMore).toHaveBeenCalledTimes(2)
    })

    it('stops automatic concise paging before prepend eviction drops a visible tail reply', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        const api = {
            getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryInChat: false }),
            getMachines: vi.fn().mockResolvedValue({ machines: [] })
        } as unknown as ApiClient

        const state = {
            sessionId: 'concise-eviction-session',
            isSyncingTail: false,
            hasMoreMessages: true,
            isLoadingMoreMessages: false,
            rawMessagesCount: 0,
            retainedMessagesCount: 20,
            normalizedMessagesCount: 0,
            visibleBlocksCount: 0,
            conciseViewActive: true,
            messagesVersion: 1,
            historyVersion: 0
        }

        const onLoadMore = vi.fn().mockImplementation(async (onBeforeApply?: (historyVersion: number) => boolean) => {
            const nextHistoryVersion = state.historyVersion + 1
            onBeforeApply?.(nextHistoryVersion)
            return {
                kind: 'applied' as const,
                historyVersion: nextHistoryVersion,
                hasMore: true,
                addedRenderableCount: 200
            }
        })

        const renderEvictionThread = () => (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <HappyThread
                        api={api}
                        session={{ metadata: {} } as Session}
                        sessionId={state.sessionId}
                        metadata={null}
                        disabled={false}
                        onRefresh={vi.fn()}
                        onViewModeChange={vi.fn()}
                        isSyncingTail={state.isSyncingTail}
                        messagesWarning={null}
                        hasMoreMessages={state.hasMoreMessages}
                        isLoadingMoreMessages={state.isLoadingMoreMessages}
                        onLoadMore={onLoadMore}
                        onCancelLoadMore={vi.fn()}
                        unseenCount={0}
                        rawMessagesCount={state.rawMessagesCount}
                        retainedMessagesCount={state.retainedMessagesCount}
                        normalizedMessagesCount={state.normalizedMessagesCount}
                        visibleBlocksCount={state.visibleBlocksCount}
                        conciseViewActive={state.conciseViewActive}
                        messagesVersion={state.messagesVersion}
                        historyVersion={state.historyVersion}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={vi.fn()}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )

        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        const result = render(renderEvictionThread())

        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMore).toHaveBeenCalledTimes(1)

        // With 25 queued prompts at the tail, pages 1..3 take non-queued
        // rawMessagesCount to 195 -> 395 -> 595 while retainedMessagesCount
        // reaches 220 -> 420 -> 620 and visibleBlocksCount becomes 1 (the
        // final reply).
        for (let page = 1; page <= 3; page += 1) {
            state.retainedMessagesCount = 20 + page * 200
            state.rawMessagesCount = state.retainedMessagesCount - 25
            state.normalizedMessagesCount = state.rawMessagesCount
            state.visibleBlocksCount = 1
            state.historyVersion = page
            searchTargetTestState.extras = { messagesVersion: 1, historyVersion: page }
            act(() => {
                result.rerender(renderEvictionThread())
            })
            act(() => {
                vi.advanceTimersByTime(16)
            })
            await act(async () => {
                await Promise.resolve()
            })
        }

        // Even though non-queued rawMessagesCount is 595 (<= 600), the
        // retained window (including 25 queued prompts) is 620 (> 600).
        // A 4th 200-row page would cross the 800-row prepend cap and evict
        // the final reply, so automatic concise coverage stops at 3 pages.
        expect(state.rawMessagesCount).toBe(595)
        expect(state.retainedMessagesCount).toBe(620)
        expect(state.visibleBlocksCount).toBe(1)
        expect(onLoadMore).toHaveBeenCalledTimes(3)
    })

    it('transitions to history mode before evicting an entirely hidden tail and stays in history mode when preceding conversation renders', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        const api = {
            getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryInChat: false }),
            getMachines: vi.fn().mockResolvedValue({ machines: [] })
        } as unknown as ApiClient

        const state = {
            sessionId: 'concise-hidden-tail-eviction-session',
            isSyncingTail: false,
            hasMoreMessages: true,
            isLoadingMoreMessages: false,
            rawMessagesCount: 620,
            retainedMessagesCount: 620,
            normalizedMessagesCount: 620,
            visibleBlocksCount: 0,
            conciseViewActive: true,
            messagesVersion: 1,
            historyVersion: 2
        }

        const onViewModeChange = vi.fn()
        const onLoadMore = vi.fn().mockImplementation(async (onBeforeApply?: (historyVersion: number) => boolean) => {
            const nextHistoryVersion = state.historyVersion + 1
            onBeforeApply?.(nextHistoryVersion)
            return {
                kind: 'applied' as const,
                historyVersion: nextHistoryVersion,
                hasMore: true,
                addedRenderableCount: 200
            }
        })

        const renderHiddenTailThread = () => (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <HappyThread
                        api={api}
                        session={{ metadata: {} } as Session}
                        sessionId={state.sessionId}
                        metadata={null}
                        disabled={false}
                        onRefresh={vi.fn()}
                        onViewModeChange={onViewModeChange}
                        isSyncingTail={state.isSyncingTail}
                        messagesWarning={null}
                        hasMoreMessages={state.hasMoreMessages}
                        isLoadingMoreMessages={state.isLoadingMoreMessages}
                        onLoadMore={onLoadMore}
                        onCancelLoadMore={vi.fn()}
                        unseenCount={0}
                        rawMessagesCount={state.rawMessagesCount}
                        retainedMessagesCount={state.retainedMessagesCount}
                        normalizedMessagesCount={state.normalizedMessagesCount}
                        visibleBlocksCount={state.visibleBlocksCount}
                        conciseViewActive={state.conciseViewActive}
                        messagesVersion={state.messagesVersion}
                        historyVersion={state.historyVersion}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={vi.fn()}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )

        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 2 }
        const result = render(renderHiddenTailThread())

        await act(async () => {
            await Promise.resolve()
        })
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        // Automatic concise coverage does not mark the window as user-selected
        // history via onViewModeChange('history'), while still rendering the
        // jump-to-latest button once the tail has been evicted.
        expect(result.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy()

        // When the older page renders visible preceding messages, initial
        // scroll settling must not re-enter tail mode (which would reset back
        // to the evicted tool-only tail).
        onViewModeChange.mockClear()
        state.rawMessagesCount = 800
        state.retainedMessagesCount = 800
        state.normalizedMessagesCount = 800
        state.visibleBlocksCount = 50
        state.messagesVersion = 2
        state.historyVersion = 3
        searchTargetTestState.extras = { messagesVersion: 2, historyVersion: 3 }
        act(() => {
            result.rerender(renderHiddenTailThread())
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })

        expect(onViewModeChange).not.toHaveBeenCalledWith('tail')
    })

    it('acknowledges post-eviction live replies through SessionChat while automatically following and suppresses user-selected history', async () => {
        const sessionId = 'session-chat-concise-eviction-read-ack'
        clearMessageWindow(sessionId)

        const sendReadState = vi.fn(async (_id: string, request: { type: 'read'; readRevision: number; expectedVersion: number } | { type: 'unread'; expectedVersion: number }) => ({
            readState: {
                readRevision: request.type === 'read' ? request.readRevision : 0,
                manualUnread: request.type === 'unread',
                version: request.expectedVersion + 1
            }
        }))
        const cleanupReadState = configureSessionReadState('session-chat-concise-eviction-scope', sendReadState)

        const allMessages: DecryptedMessage[] = Array.from({ length: 903 }, (_, index) => {
            const seq = index + 1
            const isHiddenTool = seq > 3
            return {
                id: `m-${seq}`,
                seq,
                contentRevision: seq,
                localId: null,
                createdAt: 1_000_000 + seq,
                invokedAt: 1_000_000 + seq,
                content: isHiddenTool
                    ? {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: {
                                type: 'tool-call',
                                callId: `call-${seq}`,
                                name: 'Bash',
                                input: { command: `echo ${seq}` },
                                status: 'completed'
                            }
                        }
                    }
                    : seq === 2
                        ? {
                            role: 'agent',
                            content: {
                                type: 'codex',
                                data: { type: 'message', message: 'Older assistant reply 2' }
                            }
                        }
                        : {
                            role: 'user',
                            content: { type: 'text', text: `User message ${seq}` }
                        }
            } as DecryptedMessage
        })

        const api = {
            getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryInChat: false }),
            getMachines: vi.fn().mockResolvedValue({ machines: [] }),
            getSessions: vi.fn().mockResolvedValue({ sessions: [] }),
            getScratchlist: vi.fn().mockResolvedValue({ entries: [], migratedFromLocal: false }),
            getMessages: vi.fn(async (_id: string, query?: { limit?: number; beforeSeq?: number | null }) => {
                const limit = query?.limit ?? 200
                const beforeSeq = query?.beforeSeq ?? null
                const slice = beforeSeq === null
                    ? allMessages.slice(-limit)
                    : allMessages.filter((m) => (m.seq ?? 0) < beforeSeq).slice(-limit)
                const oldest = slice[0] ?? null
                const newest = slice.at(-1) ?? null
                return {
                    messages: slice,
                    page: {
                        direction: beforeSeq === null ? 'latest' : 'before',
                        limit,
                        epoch: 1,
                        reset: false,
                        nextBeforeAt: oldest ? (oldest.invokedAt ?? oldest.createdAt) : null,
                        nextBeforeSeq: oldest?.seq ?? null,
                        nextAfterAt: null,
                        nextAfterSeq: null,
                        snapshotHeadAt: newest ? (newest.invokedAt ?? newest.createdAt) : null,
                        snapshotHeadSeq: newest?.seq ?? null,
                        hasMore: (oldest?.seq ?? 1) > 1,
                        readThroughRevision: beforeSeq === null ? (newest?.contentRevision ?? 0) : undefined
                    }
                } satisfies MessagesResponse
            })
        } as unknown as ApiClient

        let latestObservedMessagesCount = 0
        const checkBoundary = (id: string) => observedIsLatestBoundary?.(id) ?? false
        let observedIsLatestBoundary: ((id: string) => boolean) | undefined
        function BoundaryProbe() {
            const ctx = useHappyChatContext()
            observedIsLatestBoundary = ctx.isLatestCompletedBoundary
            return null
        }
        searchTargetTestState.renderMessages = () => <BoundaryProbe />

        function SessionChatHarness() {
            const { setConciseChatMode } = useConciseChatMode()
            const msg = useMessages(api, sessionId)
            latestObservedMessagesCount = msg.messages.length
            searchTargetTestState.extras = {
                messagesVersion: msg.messagesVersion,
                historyVersion: msg.historyVersion
            }
            return (
                <div>
                    <button type="button" onClick={() => setConciseChatMode(true)}>Enable concise</button>
                    <button type="button" onClick={() => { void msg.refetch() }}>Refetch tail</button>
                    <SessionChat
                        api={api}
                        session={{
                            id: sessionId,
                            active: true,
                            thinking: false,
                            agentState: null,
                            metadata: {
                                capabilities: {
                                    conversationHistory: { forkCurrent: true }
                                }
                            }
                        } as unknown as Session}
                        messages={msg.messages}
                        readThroughRevision={msg.readThroughRevision}
                        messagesWarning={msg.warning}
                        hasMoreMessages={msg.hasMore}
                        hasMoreNewerMessages={msg.hasMoreNewer}
                        isSyncingTail={msg.isSyncingTail}
                        isCatchingUpFromCache={msg.isCatchingUpFromCache}
                        isLoadingMoreMessages={msg.isLoadingMore}
                        isSending={false}
                        viewMode={msg.viewMode}
                        tailEvictedWhileFollowing={msg.tailEvictedWhileFollowing}
                        messagesVersion={msg.messagesVersion}
                        historyVersion={msg.historyVersion}
                        tailRevision={msg.tailRevision}
                        onBack={vi.fn()}
                        onRefresh={ msg.refetch }
                        onLoadMore={msg.loadMore}
                        onCancelLoadMore={msg.cancelLoadMore}
                        onSend={vi.fn(async () => false as const)}
                        onViewModeChange={msg.setViewMode}
                        onJumpToTail={msg.jumpToTail}
                    />
                </div>
            )
        }

        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })

        try {
            const result = render(
                <QueryClientProvider client={queryClient}>
                    <I18nProvider>
                        <SessionChatHarness />
                    </I18nProvider>
                </QueryClientProvider>
            )

            const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')
            if (!viewport) throw new Error('Expected chat viewport')
            let scrollHeight = 530
            Object.defineProperties(viewport, {
                scrollHeight: { configurable: true, get: () => scrollHeight },
                clientHeight: { configurable: true, value: 530 },
                scrollTop: { configurable: true, writable: true, value: 0 }
            })

            fireEvent.click(result.getByRole('button', { name: 'Enable concise' }))

            // Flush initial tail sync and automatic concise coverage across 5 older pages (900 hidden tool messages).
            for (let step = 0; step < 8; step += 1) {
                await act(async () => {
                    vi.advanceTimersByTime(200)
                    await Promise.resolve()
                })
            }

            // Older cards in the recovered window must not be treated as the current fork boundary.
            expect(checkBoundary('user-text:m-1')).toBe(false)
            expect(checkBoundary('agent-text:m-2:0')).toBe(false)
            expect(checkBoundary('user-text:m-3')).toBe(false)

            // Reconciling the tail (e.g. after a reconnect gap) replaces the evicted window with
            // the latest 200 hidden tool rows and must automatically re-arm concise coverage.
            const getMessagesCallsBeforeRefetch = (api.getMessages as ReturnType<typeof vi.fn>).mock.calls.length
            fireEvent.click(result.getByRole('button', { name: 'Refetch tail' }))
            for (let step = 0; step < 8; step += 1) {
                await act(async () => {
                    vi.advanceTimersByTime(200)
                    await Promise.resolve()
                })
            }
            expect((api.getMessages as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(getMessagesCallsBeforeRefetch + 5)
            expect(latestObservedMessagesCount).toBe(800)
            expect(checkBoundary('user-text:m-1')).toBe(false)
            expect(checkBoundary('agent-text:m-2:0')).toBe(false)
            expect(checkBoundary('user-text:m-3')).toBe(false)

            // Deliver a live final reply (seq 904, contentRevision 904) while still auto-following after hidden-tail eviction.
            scrollHeight = 900
            viewport.scrollTop = 370
            act(() => {
                ingestIncomingMessages(sessionId, [{
                    id: 'm-904',
                    seq: 904,
                    contentRevision: 904,
                    localId: null,
                    createdAt: 1_000_904,
                    invokedAt: 1_000_904,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: { type: 'message', message: 'Final live reply 904' }
                        }
                    }
                } as DecryptedMessage])
            })

            for (let step = 0; step < 4; step += 1) {
                await act(async () => {
                    vi.advanceTimersByTime(200)
                    await Promise.resolve()
                })
            }

            // The newly delivered, completed tail reply restores Fork current while older cards stay suppressed.
            expect(checkBoundary('agent-text:m-904:0')).toBe(true)
            expect(checkBoundary('user-text:m-1')).toBe(false)
            expect(checkBoundary('agent-text:m-2:0')).toBe(false)
            expect(checkBoundary('user-text:m-3')).toBe(false)

            expect(getSessionLastSeenAt(sessionId)).toBe(904)
            expect(hasUnseenContent({ id: sessionId, contentRevision: 904 }, getSessionLastSeenAt(sessionId))).toBe(false)
            expect(sendReadState).toHaveBeenCalledWith(sessionId, expect.objectContaining({
                type: 'read',
                readRevision: 904
            }))
            expect(result.queryByRole('button', { name: /new message/i })).toBeNull()
            expect(result.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy()

            // Once the user scrolls up into user-selected history, subsequent live replies must not be acknowledged.
            fireEvent.wheel(viewport, { deltaY: -120 })
            viewport.scrollTop = 100
            fireEvent.scroll(viewport)
            await act(async () => {
                vi.advanceTimersByTime(200)
                await Promise.resolve()
            })

            act(() => {
                ingestIncomingMessages(sessionId, [{
                    id: 'm-905',
                    seq: 905,
                    contentRevision: 905,
                    localId: null,
                    createdAt: 1_000_905,
                    invokedAt: 1_000_905,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: { type: 'message', message: 'Unread live reply 905' }
                        }
                    }
                } as DecryptedMessage])
            })

            for (let step = 0; step < 4; step += 1) {
                await act(async () => {
                    vi.advanceTimersByTime(200)
                    await Promise.resolve()
                })
            }

            expect(getSessionLastSeenAt(sessionId)).toBe(904)
            expect(hasUnseenContent({ id: sessionId, contentRevision: 905 }, getSessionLastSeenAt(sessionId))).toBe(true)
        } finally {
            cleanupReadState()
            clearMessageWindow(sessionId)
            localStorage.removeItem('hapi-concise-chat-mode')
        }
    })

    it('allows automatic coverage when full view has a sidechain-only initial window with zero visible blocks', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        const api = {
            getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false })
        } as unknown as ApiClient

        const state = {
            sessionId: 'full-view-sidechain-only-session',
            isSyncingTail: false,
            hasMoreMessages: true,
            isLoadingMoreMessages: false,
            rawMessagesCount: 220,
            normalizedMessagesCount: 220,
            visibleBlocksCount: 0,
            conciseViewActive: false,
            messagesVersion: 1,
            historyVersion: 0
        }

        const onLoadMore = vi.fn().mockImplementation(async (onBeforeApply?: (historyVersion: number) => boolean) => {
            const nextHistoryVersion = state.historyVersion + 1
            onBeforeApply?.(nextHistoryVersion)
            return {
                kind: 'applied' as const,
                historyVersion: nextHistoryVersion,
                hasMore: false,
                addedRenderableCount: 200
            }
        })

        const renderFullViewThread = () => (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <HappyThread
                        api={api}
                        session={{ metadata: {} } as Session}
                        sessionId={state.sessionId}
                        metadata={null}
                        disabled={false}
                        onRefresh={vi.fn()}
                        onViewModeChange={vi.fn()}
                        isSyncingTail={state.isSyncingTail}
                        messagesWarning={null}
                        hasMoreMessages={state.hasMoreMessages}
                        isLoadingMoreMessages={state.isLoadingMoreMessages}
                        onLoadMore={onLoadMore}
                        onCancelLoadMore={vi.fn()}
                        unseenCount={0}
                        rawMessagesCount={state.rawMessagesCount}
                        normalizedMessagesCount={state.normalizedMessagesCount}
                        visibleBlocksCount={state.visibleBlocksCount}
                        conciseViewActive={state.conciseViewActive}
                        messagesVersion={state.messagesVersion}
                        historyVersion={state.historyVersion}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={vi.fn()}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )

        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 0 }
        const result = render(renderFullViewThread())
        const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')!
        const sentinel = result.container.querySelector<HTMLElement>('.chat-scroll-content > [aria-hidden="true"]')!
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, value: 530 },
            clientHeight: { configurable: true, value: 530 }
        })
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        act(() => {
            resizeCallbacks.at(-1)?.()
        })
        await act(async () => {
            await Promise.resolve()
        })

        expect(onLoadMore).toHaveBeenCalledTimes(1)

        state.rawMessagesCount = 420
        state.normalizedMessagesCount = 420
        state.visibleBlocksCount = 15
        state.hasMoreMessages = false
        state.historyVersion = 1
        searchTargetTestState.extras = { messagesVersion: 1, historyVersion: 1 }
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_530 })
        act(() => {
            result.rerender(renderFullViewThread())
        })

        expect(viewport.scrollTop).toBe(1_000)
    })
})
