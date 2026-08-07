import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import React from 'react'

// ReasoningGroup consumes `useMessage` from assistant-ui. Mock it so the
// message status/content can be controlled per test.
const { mockMessage, onNestedScrollFollowChange } = vi.hoisted(() => ({
    mockMessage: {
        status: null as { type: string } | null,
        content: [] as { type: string }[],
    },
    onNestedScrollFollowChange: vi.fn(),
}))

vi.mock('@assistant-ui/react', () => ({
    useMessage: () => mockMessage,
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => ({ onNestedScrollFollowChange }),
}))

import { ReasoningGroup } from './reasoning'

const STORAGE_KEY = 'hapi-reasoning-collapsed'

function renderGroup() {
    return render(
        <ReasoningGroup>
            <div data-testid="reasoning-content">thinking text</div>
        </ReasoningGroup>
    )
}

// The collapsible region is the direct div child of .aui-reasoning-group
// (the header is a button). Collapsed state is signalled by the max-h-0 class.
function isCollapsed(container: HTMLElement): boolean {
    const region = container.querySelector('.aui-reasoning-group > div') as HTMLElement
    return region.className.includes('max-h-0')
}

function setStreaming() {
    mockMessage.status = { type: 'running' }
    mockMessage.content = [{ type: 'reasoning' }]
}

describe('ReasoningGroup', () => {
    beforeEach(() => {
        window.localStorage.clear()
        cleanup()
        mockMessage.status = null
        mockMessage.content = []
        onNestedScrollFollowChange.mockReset()
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(0)
            return 1
        })
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    })

    it('is collapsed by default', () => {
        const { container } = renderGroup()
        expect(isCollapsed(container)).toBe(true)
    })

    it('expands on click', () => {
        const { container } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        expect(scroll.tabIndex).toBe(-1)
        fireEvent.click(container.querySelector('button')!)
        expect(isCollapsed(container)).toBe(false)
        expect(scroll.tabIndex).toBe(0)
    })

    it('auto-expands while streaming', () => {
        const { container, rerender } = renderGroup()
        setStreaming()
        rerender(
            <ReasoningGroup>
                <div data-testid="reasoning-content">thinking text</div>
            </ReasoningGroup>
        )
        expect(isCollapsed(container)).toBe(false)
    })

    it('stays collapsed while streaming when the preference is enabled', () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        const { container, rerender } = renderGroup()
        setStreaming()
        rerender(
            <ReasoningGroup>
                <div data-testid="reasoning-content">thinking text</div>
            </ReasoningGroup>
        )
        expect(isCollapsed(container)).toBe(true)
    })

    it('collapses an auto-expanded streaming block when the preference is enabled from another tab', () => {
        const { container, rerender } = renderGroup()
        setStreaming()
        rerender(
            <ReasoningGroup>
                <div data-testid="reasoning-content">thinking text</div>
            </ReasoningGroup>
        )
        expect(isCollapsed(container)).toBe(false)

        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        Object.defineProperties(scroll, {
            scrollHeight: { configurable: true, value: 500 },
            clientHeight: { configurable: true, value: 100 },
        })
        scroll.scrollTop = 100
        fireEvent.scroll(scroll)
        expect(onNestedScrollFollowChange).toHaveBeenLastCalledWith(false)

        act(() => {
            window.localStorage.setItem(STORAGE_KEY, 'true')
            window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
        })

        expect(isCollapsed(container)).toBe(true)
        expect(onNestedScrollFollowChange).toHaveBeenLastCalledWith(true)
    })

    it('opens a streaming reasoning panel at the latest content and follows new output at the bottom', () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        setStreaming()
        const { container, rerender } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        let scrollHeight = 500
        Object.defineProperties(scroll, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, get: () => 100 },
        })

        fireEvent.click(container.querySelector('button')!)
        expect(scroll.scrollTop).toBe(500)

        scrollHeight = 700
        rerender(
            <ReasoningGroup>
                <div data-testid="reasoning-content">more thinking text</div>
            </ReasoningGroup>
        )
        expect(scroll.scrollTop).toBe(700)
    })

    it('stops following new output after the user scrolls away from the bottom', () => {
        setStreaming()
        const { container, rerender } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        let scrollHeight = 500
        Object.defineProperties(scroll, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, get: () => 100 },
        })
        scroll.scrollTop = 100
        fireEvent.scroll(scroll)

        scrollHeight = 700
        rerender(
            <ReasoningGroup>
                <div data-testid="reasoning-content">more thinking text</div>
            </ReasoningGroup>
        )
        expect(scroll.scrollTop).toBe(100)
    })

    it('releases nested scroll ownership when a scrolled-away panel is collapsed', () => {
        setStreaming()
        const { container } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        Object.defineProperties(scroll, {
            scrollHeight: { configurable: true, value: 500 },
            clientHeight: { configurable: true, value: 100 },
        })
        scroll.scrollTop = 100
        fireEvent.scroll(scroll)
        expect(onNestedScrollFollowChange).toHaveBeenLastCalledWith(false)

        fireEvent.click(container.querySelector('button')!)

        expect(isCollapsed(container)).toBe(true)
        expect(scroll.tabIndex).toBe(-1)
        expect(onNestedScrollFollowChange).toHaveBeenLastCalledWith(true)
    })

    it('restores follow-tail after a pointer gesture ends without scrolling', () => {
        const { container } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        Object.defineProperties(scroll, {
            scrollHeight: { configurable: true, value: 500 },
            clientHeight: { configurable: true, value: 100 },
        })
        scroll.scrollTop = 400

        fireEvent.pointerDown(scroll)
        fireEvent.pointerUp(window)

        expect(onNestedScrollFollowChange.mock.calls).toEqual([[false], [true]])
    })

    it('keeps nested ownership until pointer-up while reasoning continues streaming', () => {
        setStreaming()
        const { container, rerender } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        let scrollHeight = 500
        Object.defineProperties(scroll, {
            scrollHeight: { configurable: true, get: () => scrollHeight },
            clientHeight: { configurable: true, get: () => 100 },
        })
        scroll.scrollTop = 400

        fireEvent.pointerDown(scroll)
        scrollHeight = 700
        rerender(
            <ReasoningGroup>
                <div data-testid="reasoning-content">more thinking text</div>
            </ReasoningGroup>
        )
        fireEvent.scroll(scroll)

        expect(scroll.scrollTop).toBe(400)
        expect(onNestedScrollFollowChange.mock.calls).toEqual([[false], [false]])

        fireEvent.pointerUp(window)
        expect(onNestedScrollFollowChange).toHaveBeenLastCalledWith(false)
    })

    it('restores follow-tail after a boundary wheel gesture cannot scroll', () => {
        const { container } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        Object.defineProperties(scroll, {
            scrollHeight: { configurable: true, value: 100 },
            clientHeight: { configurable: true, value: 100 },
        })

        fireEvent.wheel(scroll)

        expect(onNestedScrollFollowChange.mock.calls).toEqual([[false], [true]])
    })
})
