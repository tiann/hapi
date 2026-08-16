import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    captureScrollAnchor,
    getHistoryCoverageRetryDelay,
    getPullToLoadState,
    getScrollIntent,
    hasAppliedHistoryVersion,
    isNestedScrollEvent,
    locateOutlineTargetMessage,
    prependMissingUserSnapshot,
    restoreScrollAnchor,
    shouldLoadOlderForViewport,
    shouldCancelInitialScrollSettling,
    ThreadMessagesById,
} from '@/components/AssistantChat/HappyThread'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ConversationOutlineItem } from '@/chat/outline'

const outlineItems: ConversationOutlineItem[] = [
    {
        id: 'outline:user-text:m1',
        targetMessageId: 'user-text:m1',
        kind: 'user',
        label: 'Implement the panel',
        createdAt: 1000
    },
    {
        id: 'outline:user-text:m2',
        targetMessageId: 'user-text:m2',
        kind: 'user',
        label: 'Second user prompt',
        createdAt: 2000
    }
]

describe('nested scroll event ownership', () => {
    it('recognizes events from a nested scroll viewport and its descendants', () => {
        const nested = document.createElement('div')
        nested.dataset.hapiNestedScroll = 'true'
        const child = document.createElement('span')
        child.textContent = 'reasoning'
        nested.append(child)
        document.body.append(nested)

        const nestedEvent = new Event('wheel')
        Object.defineProperty(nestedEvent, 'target', { value: nested })
        const childEvent = new Event('keydown')
        Object.defineProperty(childEvent, 'target', { value: child })

        expect(isNestedScrollEvent(new WheelEvent('wheel'))).toBe(false)
        expect(isNestedScrollEvent(nestedEvent)).toBe(true)
        expect(isNestedScrollEvent(childEvent)).toBe(true)

        nested.remove()
    })
})

describe('ThreadMessagesById', () => {
    it('does not crash when rewind shortens the transcript and then clears it', async () => {
        type TestMessage = { id: string; role: 'user' | 'assistant'; text: string }
        let setMessages!: (messages: TestMessage[]) => void
        function Harness() {
            const [messages, updateMessages] = useState<TestMessage[]>([
                { id: 'user-1', role: 'user', text: 'first' },
                { id: 'assistant-1', role: 'assistant', text: 'answer' },
                { id: 'user-2', role: 'user', text: 'second' },
                { id: 'assistant-2', role: 'assistant', text: 'second answer' }
            ])
            setMessages = updateMessages
            const runtime = useExternalStoreRuntime({
                messages,
                convertMessage: (message): ThreadMessageLike => ({
                    id: message.id,
                    role: message.role,
                    content: [{ type: 'text', text: message.text }]
                }),
                onNew: async () => {}
            })
            return (
                <AssistantRuntimeProvider runtime={runtime}>
                    <ThreadMessagesById components={{
                        UserMessage: () => <div data-testid="user-message" />,
                        AssistantMessage: () => <div data-testid="assistant-message" />,
                        SystemMessage: () => <div data-testid="system-message" />
                    }} />
                </AssistantRuntimeProvider>
            )
        }

        render(<Harness />)
        expect(screen.getAllByTestId('user-message')).toHaveLength(2)
        expect(screen.getAllByTestId('assistant-message')).toHaveLength(2)

        await act(async () => {
            setMessages([
                { id: 'user-1', role: 'user', text: 'first' },
                { id: 'assistant-1', role: 'assistant', text: 'answer' }
            ])
        })

        await waitFor(() => {
            expect(screen.getAllByTestId('user-message')).toHaveLength(1)
            expect(screen.getAllByTestId('assistant-message')).toHaveLength(1)
        })

        await act(async () => {
            setMessages([])
        })

        await waitFor(() => {
            expect(screen.queryByTestId('user-message')).not.toBeInTheDocument()
            expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument()
        })
    })
})

function rect(values: Pick<DOMRect, 'top' | 'bottom'> & Partial<DOMRect>): DOMRect {
    return {
        left: 0,
        right: 300,
        width: 300,
        height: values.bottom - values.top,
        x: 0,
        y: values.top,
        toJSON: () => ({}),
        ...values
    } as DOMRect
}

function renderPanel(props: Partial<ComponentProps<typeof ConversationOutlinePanel>> = {}) {
    return render(
        <I18nProvider>
            <ConversationOutlinePanel
                items={outlineItems}
                hasMoreMessages={false}
                isLoadingMoreMessages={false}
                onLoadMore={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('ConversationOutlinePanel', () => {
    it('renders outline items and selects an item', () => {
        const onSelect = vi.fn()
        renderPanel({ onSelect })

        fireEvent.click(screen.getByText('Implement the panel'))

        expect(onSelect).toHaveBeenCalledWith(outlineItems[0])
    })

    it('shows each message time instead of a redundant user label', () => {
        const { container } = renderPanel()

        const timestamps = container.querySelectorAll('time')
        expect(timestamps).toHaveLength(outlineItems.length)
        expect(timestamps[0]).toHaveAttribute('dateTime', new Date(outlineItems[0].createdAt).toISOString())
        expect(timestamps[0]).toHaveAttribute('title')
        expect(screen.queryByText('User')).not.toBeInTheDocument()
    })

    it('shows load earlier when older messages exist', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))

        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('uses a concise placeholder for outline search', () => {
        renderPanel()

        expect(screen.getByPlaceholderText('Search outline')).toBeInTheDocument()
    })

    it('filters loaded outline items without hiding load earlier', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
            target: { value: 'SECOND' }
        })

        expect(screen.queryByText('Implement the panel')).not.toBeInTheDocument()
        expect(screen.getByText('Second user prompt')).toBeInTheDocument()
        expect(screen.getByText('1 of 2 items')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))
        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('supports wildcard patterns in outline search', () => {
        renderPanel()

        const searchbox = screen.getByRole('searchbox', { name: 'Search outline items' })
        fireEvent.change(searchbox, { target: { value: 'Implement*' } })

        expect(screen.getByText('Implement the panel')).toBeInTheDocument()
        expect(screen.queryByText('Second user prompt')).not.toBeInTheDocument()

        fireEvent.change(searchbox, { target: { value: 'Second user p?????' } })

        expect(screen.queryByText('Implement the panel')).not.toBeInTheDocument()
        expect(screen.getByText('Second user prompt')).toBeInTheDocument()
    })

    it('lets the shared matcher normalize outline queries consistently', () => {
        const toLocaleLowerCase = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
            return this.toString() === 'I' ? 'ı' : this.toLowerCase()
        })
        try {
            renderPanel({
                items: [
                    ...outlineItems,
                    {
                        id: 'outline:user-text:m3',
                        targetMessageId: 'user-text:m3',
                        kind: 'user',
                        label: 'Istanbul deployment',
                        createdAt: 3000
                    }
                ]
            })
            fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
                target: { value: 'I' }
            })

            expect(screen.getByText('Istanbul deployment')).toBeInTheDocument()
        } finally {
            toLocaleLowerCase.mockRestore()
        }
    })

    it('shows a search-specific empty state', () => {
        renderPanel()

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
            target: { value: 'missing' }
        })

        expect(screen.getByText('No matching outline items')).toBeInTheDocument()
        expect(screen.queryByText('No outline items in loaded messages')).not.toBeInTheDocument()
    })

    it('keeps an in-panel close action available', () => {
        const onClose = vi.fn()
        renderPanel({ onClose })

        const closeButton = screen.getByRole('button', { name: 'Close' })
        expect(closeButton).toHaveClass('border', 'rounded-md', 'h-9', 'w-9')
        fireEvent.click(closeButton)

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders an empty state', () => {
        renderPanel({ items: [] })

        expect(screen.getByText('No outline items in loaded messages')).toBeInTheDocument()
    })
})

describe('scroll anchor helpers', () => {
    it('captures the first visible message relative to the viewport', () => {
        const viewport = document.createElement('div')
        const first = document.createElement('div')
        const second = document.createElement('div')
        first.id = 'first-message'
        second.id = 'second-message'
        viewport.className = 'viewport'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(first, second)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 90 }))
        vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect({ top: 120, bottom: 180 }))

        expect(captureScrollAnchor(viewport)).toEqual({
            id: 'second-message',
            topOffset: 20
        })

        viewport.remove()
    })

    it('treats upward motion near the bottom as manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 690,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 12,
            isNearBottom: false,
            isScrollingUp: true
        })
    })

    it('does not resume tail-following merely because downward reading is close to the bottom', () => {
        expect(getScrollIntent({
            scrollTop: 610,
            previousScrollTop: 590,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 92,
            isNearBottom: false,
            isScrollingUp: false
        })
    })

    it('does not classify downward movement as upward manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 690,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 0,
            isNearBottom: true,
            isScrollingUp: false
        })
    })

    it('cancels initial scroll settling when the user scrolls up away from the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 520,
            previousScrollTop: 700,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 182,
            isScrollingUp: true
        })
        expect(shouldCancelInitialScrollSettling(intent, true)).toBe(true)
    })

    it('keeps initial scroll settling for programmatic upward movement', () => {
        const intent = getScrollIntent({
            scrollTop: 0,
            previousScrollTop: 700,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(shouldCancelInitialScrollSettling(intent, false)).toBe(false)
    })

    it('keeps initial scroll settling for negligible movement at the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 0,
            isScrollingUp: false
        })
        expect(shouldCancelInitialScrollSettling(intent, false)).toBe(false)
    })

    it('restores the captured message to the same viewport offset', () => {
        const viewport = document.createElement('div')
        const message = document.createElement('div')
        message.id = 'anchored-message'
        viewport.append(message)
        document.body.append(viewport)
        viewport.scrollTop = 200

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect({ top: 180, bottom: 260 }))

        expect(restoreScrollAnchor(viewport, { id: 'anchored-message', topOffset: 30 })).toBe(true)
        expect(viewport.scrollTop).toBe(250)

        viewport.remove()
    })

    it('waits until assistant-ui has applied the loaded history version', () => {
        expect(hasAppliedHistoryVersion(4, 4)).toBe(false)
        expect(hasAppliedHistoryVersion(4, 5)).toBe(true)
    })
})

describe('top-triggered history loading', () => {
    it('recognizes an underfilled viewport and a top sentinel inside the preload margin', () => {
        expect(shouldLoadOlderForViewport({
            scrollHeight: 300,
            clientHeight: 500,
            viewportTop: 100,
            sentinelTop: 100,
            sentinelBottom: 101
        })).toBe(true)
        expect(shouldLoadOlderForViewport({
            scrollHeight: 1_000,
            clientHeight: 500,
            viewportTop: 100,
            sentinelTop: -200,
            sentinelBottom: -199
        })).toBe(false)
    })

    it('defers an intersection signal until the initial scroll-settling deadline', () => {
        expect(getHistoryCoverageRetryDelay(2_800, 1_000)).toBe(1_816)
        expect(getHistoryCoverageRetryDelay(900, 1_000)).toBe(16)
    })

    it('shows pull feedback at 16px and arms release loading at 64px', () => {
        expect(getPullToLoadState(15)).toBe('idle')
        expect(getPullToLoadState(16)).toBe('pulling')
        expect(getPullToLoadState(63)).toBe('pulling')
        expect(getPullToLoadState(64)).toBe('ready')
    })
})

describe('outline target loading', () => {
    it('loads older messages through the scroll-preserving wrapper until the target appears', async () => {
        const loadOlderPreservingScroll = vi.fn<() => Promise<boolean>>()
        let loadCount = 0
        loadOlderPreservingScroll.mockImplementation(async () => {
            loadCount += 1
            return true
        })

        const findTarget = vi.fn((anchorId: string) => {
            if (anchorId !== 'hapi-message-user-text:target') {
                return null
            }
            return loadCount >= 2 ? document.createElement('div') : null
        })

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:target',
            findTarget,
            hasMoreMessages: () => loadCount < 2,
            loadOlderPreservingScroll
        })

        expect(target).toBeInstanceOf(HTMLElement)
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(2)
        expect(findTarget).toHaveBeenCalledWith('hapi-message-user-text:target')
    })

    it('stops when history is exhausted before the target is loaded', async () => {
        const loadOlderPreservingScroll = vi.fn(async () => false)

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:missing',
            findTarget: () => null,
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })

        expect(target).toBeNull()
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(1)
    })
})

describe('share turn snapshots', () => {
    it('restores the preceding user prompt when a long rendered turn only contains assistant DOM', () => {
        const assistant = { html: '<div data-hapi-message-role="assistant">answer</div>', text: 'answer', role: 'assistant' as const }
        const user = { html: '', text: 'original long-conversation prompt', role: 'user' as const }

        expect(prependMissingUserSnapshot([assistant], user)).toEqual([user, assistant])
    })

    it('does not duplicate a user prompt already captured from the DOM', () => {
        const user = { html: '<div data-hapi-message-role="user">prompt</div>', text: 'prompt' }
        const fallback = { html: '', text: 'prompt', role: 'user' as const }

        expect(prependMissingUserSnapshot([user], fallback)).toEqual([user])
    })
})
