import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    ConversationStartStatus,
    captureScrollAnchor,
    findPreviousUserMessage,
    getScrollIntent,
    loadAllOlderMessages,
    locateOutlineTargetMessage,
    restoreScrollAnchor,
    shouldCancelInitialScrollSettling,
} from '@/components/AssistantChat/HappyThread'
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

describe('ConversationStartStatus', () => {
    it('announces loading and completion states', () => {
        const { rerender } = render(
            <I18nProvider><ConversationStartStatus status="loading" /></I18nProvider>
        )
        expect(screen.getByRole('status')).toHaveTextContent('Loading earlier messages…')

        rerender(<I18nProvider><ConversationStartStatus status="success" /></I18nProvider>)
        expect(screen.getByRole('status')).toHaveTextContent('Reached conversation start')
    })

    it('uses an alert for load failures', () => {
        render(<I18nProvider><ConversationStartStatus status="error" /></I18nProvider>)
        expect(screen.getByRole('alert')).toHaveTextContent('Could not load earlier messages. Try again.')
    })

    it('announces prompt loading separately from conversation-start loading', () => {
        render(<I18nProvider><ConversationStartStatus status="loading" kind="prompt" /></I18nProvider>)
        expect(screen.getByRole('status')).toHaveTextContent('Loading turn input…')
    })
})

describe('assistant prompt lookup', () => {
    it('finds the nearest preceding user message', () => {
        const viewport = document.createElement('div')
        viewport.innerHTML = `
            <div class="happy-thread-messages">
                <div id="hapi-message-user-text:first" data-hapi-message-role="user"></div>
                <div id="hapi-message-agent-text:first-answer"></div>
                <div id="hapi-message-user-text:second" data-hapi-message-role="user"></div>
                <div id="hapi-message-agent-text:second-answer"></div>
            </div>
        `

        expect(findPreviousUserMessage(viewport, 'agent-text:second-answer')?.id)
            .toBe('hapi-message-user-text:second')
    })

    it('returns null when the prompt is outside the loaded history window', () => {
        const viewport = document.createElement('div')
        viewport.innerHTML = `
            <div class="happy-thread-messages">
                <div id="hapi-message-agent-text:answer"></div>
            </div>
        `

        expect(findPreviousUserMessage(viewport, 'agent-text:answer')).toBeNull()
    })

    it('recognizes user-role CLI output as a turn input', () => {
        const viewport = document.createElement('div')
        viewport.innerHTML = `
            <div class="happy-thread-messages">
                <div id="hapi-message-cli-output:command" data-hapi-message-role="user"></div>
                <div id="hapi-message-cli-output:result"></div>
            </div>
        `

        expect(findPreviousUserMessage(viewport, 'cli-output:result')?.id)
            .toBe('hapi-message-cli-output:command')
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

    it('shows load earlier when older messages exist', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))

        expect(onLoadMore).toHaveBeenCalledTimes(1)
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

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))

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
            isNearBottom: true,
            isScrollingUp: true
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
        expect(shouldCancelInitialScrollSettling(intent)).toBe(true)
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
        expect(shouldCancelInitialScrollSettling(intent)).toBe(false)
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

describe('conversation-start loading', () => {
    it('loads every older page from one action', async () => {
        let remainingPages = 3
        const loadOlderPreservingScroll = vi.fn(async () => {
            remainingPages -= 1
            return true
        })

        await expect(loadAllOlderMessages({
            hasMoreMessages: () => remainingPages > 0,
            loadOlderPreservingScroll
        })).resolves.toBe(true)
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(3)
    })

    it('stops when a page fails to load', async () => {
        const loadOlderPreservingScroll = vi.fn(async () => false)

        await expect(loadAllOlderMessages({
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })).resolves.toBe(false)
        expect(loadOlderPreservingScroll).toHaveBeenCalledOnce()
    })
})
