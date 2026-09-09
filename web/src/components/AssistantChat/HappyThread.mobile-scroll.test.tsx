import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { HappyChatContextValue } from '@/components/AssistantChat/context'
import { getConversationMessageAnchorId } from '@/chat/outline'

const happyChatCapture = vi.hoisted(() => ({
    current: null as HappyChatContextValue | null
}))

const shareDialogCapture = vi.hoisted(() => ({
    snapshots: [] as Array<{ html: string; text: string; role?: 'user' | 'assistant' }>
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({ machines: [] })
}))

vi.mock('@/components/AssistantChat/ShareTurnDialog', () => ({
    ShareTurnDialog: (props: { sourceSnapshots: typeof shareDialogCapture.snapshots }) => {
        shareDialogCapture.snapshots = props.sourceSnapshots
        return null
    }
}))

vi.mock('@assistant-ui/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@assistant-ui/react')>()
    const { useOptionalHappyChatContext } = await import('@/components/AssistantChat/context')
    return {
        ...actual,
        useAuiState: (selector: (state: unknown) => unknown) => selector({
            thread: { extras: undefined }
        }),
        unstable_useThreadMessageIds: () => ['capture'],
        ThreadPrimitive: {
            ...actual.ThreadPrimitive,
            Root: ({ children, className }: PropsWithChildren<{ className?: string }>) => (
                <div className={className}>{children}</div>
            ),
            Viewport: ({ children }: PropsWithChildren) => children,
            Messages: () => null,
            Unstable_MessageById: function CaptureHappyChatContext() {
                happyChatCapture.current = useOptionalHappyChatContext()
                return null
            }
        }
    }
})

import { HappyThread } from '@/components/AssistantChat/HappyThread'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

function renderThread(onViewModeChange = vi.fn()) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    const renderHappyThread = (forceScrollToken: number) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <HappyThread
                    api={{ getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false }) } as unknown as ApiClient}
                    session={{ id: 'mobile-scroll-session', metadata: {} } as Session}
                    sessionId="mobile-scroll-session"
                    metadata={null}
                    disabled={false}
                    onRefresh={vi.fn()}
                    onViewModeChange={onViewModeChange}
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
    happyChatCapture.current = null
    shareDialogCapture.snapshots = []
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
    if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
    } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
})

describe('mobile initial scroll settling', () => {
    it('does not share messages across a transcript gap', () => {
        const { container } = renderThread()
        const context = happyChatCapture.current
        if (!context?.onShareTurn) throw new Error('Share handler was not captured')
        const messages = container.querySelector<HTMLElement>('.happy-thread-messages')
        if (!messages) throw new Error('Message container was not rendered')
        messages.innerHTML = `
            <div data-hapi-message-role="user">head prompt</div>
            <div data-hapi-message-role="assistant">head answer</div>
            <div data-hapi-transcript-gap="true">history gap</div>
            <div id="tail-answer" data-hapi-message-role="assistant">tail answer</div>
        `

        act(() => context.onShareTurn!(document.getElementById('tail-answer')))

        expect(shareDialogCapture.snapshots).toHaveLength(1)
        expect(shareDialogCapture.snapshots[0]?.text).toBe('tail answer')
    })

    it('returns to tail mode after a failed prompt jump from the bottom', async () => {
        const { viewport, onViewModeChange } = renderThread()
        const context = happyChatCapture.current
        if (!context) throw new Error('Happy chat context was not captured')
        onViewModeChange.mockClear()

        const promptJump = context.jumpToPrompt('agent-text:missing')
        let result = true
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
            result = await promptJump
        })

        expect(result).toBe(false)
        expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight)
        expect(onViewModeChange).toHaveBeenLastCalledWith('tail')
    })

    it('replaces a conversation-start result with the next prompt-jump result', async () => {
        const { container, viewport } = renderThread()
        const context = happyChatCapture.current
        if (!context) throw new Error('Happy chat context was not captured')

        const conversationStart = context.scrollToConversationStart()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
            await conversationStart
        })
        expect(screen.getByRole('status')).toHaveTextContent('Reached conversation start')

        const messages = container.querySelector<HTMLElement>('.happy-thread-messages')
        if (!messages) throw new Error('Message container was not rendered')
        const prompt = document.createElement('div')
        prompt.id = getConversationMessageAnchorId('user-text:prompt')
        prompt.dataset.hapiMessageRole = 'user'
        prompt.scrollIntoView = vi.fn()
        prompt.getBoundingClientRect = () => ({
            top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
            x: 0, y: 0, toJSON: () => ({})
        }) as DOMRect
        const answer = document.createElement('div')
        answer.id = getConversationMessageAnchorId('agent-text:answer')
        messages.append(prompt, answer)
        viewport.getBoundingClientRect = () => ({
            top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
            x: 0, y: 0, toJSON: () => ({})
        }) as DOMRect

        const promptJump = context.jumpToPrompt('agent-text:answer')
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
            await promptJump
        })

        expect(screen.getByRole('status')).toHaveTextContent('Reached turn input')

        let directPromptJump: Promise<boolean> | null = null
        act(() => {
            directPromptJump = context.jumpToPrompt('agent-text:answer', 'user-text:prompt')
        })
        expect(screen.getByRole('status')).toHaveTextContent('Loading turn input')
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250)
            await directPromptJump
        })
        expect(screen.getByRole('status')).toHaveTextContent('Reached turn input')
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
