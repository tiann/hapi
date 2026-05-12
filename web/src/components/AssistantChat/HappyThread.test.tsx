import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    captureScrollAnchor,
    getScrollIntent,
    locateOutlineTargetMessage,
    restoreScrollAnchor,
    shouldCancelInitialScrollSettling,
} from '@/components/AssistantChat/HappyThread'
import type { ConversationOutlineItem } from '@/chat/outline'

const outlineItems: ConversationOutlineItem[] = [
    {
        id: 'outline:user:m1',
        targetMessageId: 'user:m1',
        kind: 'user',
        label: 'Implement the panel',
        createdAt: 1000
    },
    {
        id: 'outline:user:m2',
        targetMessageId: 'user:m2',
        kind: 'user',
        label: 'Second user prompt',
        createdAt: 2000
    }
]

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
                title="project"
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
            if (anchorId !== 'hapi-message-user:target') {
                return null
            }
            return loadCount >= 2 ? document.createElement('div') : null
        })

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user:target',
            findTarget,
            hasMoreMessages: () => loadCount < 2,
            loadOlderPreservingScroll
        })

        expect(target).toBeInstanceOf(HTMLElement)
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(2)
        expect(findTarget).toHaveBeenCalledWith('hapi-message-user:target')
    })

    it('stops when history is exhausted before the target is loaded', async () => {
        const loadOlderPreservingScroll = vi.fn(async () => false)

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user:missing',
            findTarget: () => null,
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })

        expect(target).toBeNull()
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(1)
    })
})
