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

vi.mock('@assistant-ui/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@assistant-ui/react')>()
    return {
        ...actual,
        useAuiState: (selector: (state: unknown) => unknown) => selector({
            thread: { extras: searchTargetTestState.extras }
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
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

function renderThread(onViewModeChange = vi.fn(), onJumpToTail?: () => void) {
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
                    unseenCount={0}
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
})

function renderSearchThread(options: {
    initialTargetMessageId?: string
    initialTargetMessageQuery?: string
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
    const renderHappyThread = () => (
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
                    initialTargetMessageId={options.initialTargetMessageId}
                    initialTargetMessageQuery={options.initialTargetMessageQuery}
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
    it('uses the explicit tail transition when a send requests a forced scroll', () => {
        const onViewModeChange = vi.fn()
        const onJumpToTail = vi.fn()
        const { rerenderThread } = renderThread(onViewModeChange, onJumpToTail)
        onViewModeChange.mockClear()

        rerenderThread(1)

        expect(onJumpToTail).toHaveBeenCalledTimes(1)
        expect(onViewModeChange).not.toHaveBeenCalledWith('tail')
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
    it('waits for assistant-ui to apply the current message window before anchoring', () => {
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
        act(() => {
            result.rerender(renderHappyThread())
        })

        expect(onLoadMessageContext).not.toHaveBeenCalled()
        expect(onInitialTargetConsumed).toHaveBeenCalledTimes(1)
        expect(result.container.querySelector('[data-testid="search-target-status"]')).not.toBeInTheDocument()
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

        options.initialTargetMessageId = undefined
        act(() => {
            result.rerender(renderHappyThread())
        })
        options.initialTargetMessageId = 'target-message'
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
