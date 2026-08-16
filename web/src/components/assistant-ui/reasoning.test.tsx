import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, cleanup, screen } from '@testing-library/react'
import React from 'react'

// ReasoningGroup consumes assistant-ui message state. Mock it so the message
// status and per-part status can be controlled per test.
const { mockMessage, onNestedScrollFollowChange } = vi.hoisted(() => ({
    mockMessage: {
        status: null as { type: string } | null,
        content: [] as { type: string }[],
        parts: [] as { type: string; status: { type: string } }[],
    },
    onNestedScrollFollowChange: vi.fn(),
}))

vi.mock('@assistant-ui/react', () => ({
    useMessage: () => mockMessage,
    useAuiState: (selector: (state: { message: typeof mockMessage }) => unknown) =>
        selector({ message: mockMessage }),
}))

vi.mock('@assistant-ui/react-markdown', () => ({
    MarkdownTextPrimitive: ({ smooth }: { smooth?: boolean }) => (
        <div data-testid="reasoning-markdown" data-smooth={String(smooth)}>
            reasoning text
        </div>
    )
}))

vi.mock('@/components/assistant-ui/markdown-text', () => ({
    MARKDOWN_CLASSNAME: '',
    MARKDOWN_COMPONENTS_BY_LANGUAGE: {},
    MARKDOWN_PLUGINS: [],
    MARKDOWN_REHYPE_PLUGINS: [],
    defaultComponents: {},
    denyOnlyTransform: vi.fn(),
    UriConfirmProvider: ({ children }: React.PropsWithChildren) => <>{children}</>
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => ({ onNestedScrollFollowChange }),
}))

import { Reasoning, ReasoningGroup } from './reasoning'

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
    mockMessage.parts = [{ type: 'reasoning', status: { type: 'running' } }]
}

function setHydratedReasoning() {
    mockMessage.status = { type: 'running' }
    mockMessage.content = [{ type: 'reasoning' }]
    mockMessage.parts = [{ type: 'reasoning', status: { type: 'complete' } }]
}

function renderReasoning(text: string, statusType: 'complete' | 'running' = 'complete') {
    return render(<Reasoning type="reasoning" text={text} status={{ type: statusType }} />)
}

describe('ReasoningGroup', () => {
    beforeEach(() => {
        window.localStorage.clear()
        cleanup()
        mockMessage.status = null
        mockMessage.content = []
        mockMessage.parts = []
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

    it('does not contain overscroll so the outer chat keeps scrolling past the panel boundary', () => {
        // Scroll chaining is native browser behavior: once the panel reaches
        // its bottom, the next wheel gesture must keep scrolling the outer
        // chat viewport. overscroll-behavior-y: contain (Tailwind
        // `overscroll-y-contain`) blocks exactly that — it was removed in
        // #1264 and must not come back (regression from #1398).
        const { container } = renderGroup()
        const scroll = container.querySelector('.aui-reasoning-scroll') as HTMLDivElement
        expect(scroll.className).not.toContain('overscroll-y-contain')
    })

    it('does not show a running indicator when only the message status is running', () => {
        setHydratedReasoning()
        const { container } = renderGroup()

        expect(container.querySelector('.animate-pulse')).toBeNull()
        expect(isCollapsed(container)).toBe(true)
    })

    it('uses the reasoning part status for the running indicator', () => {
        setHydratedReasoning()
        const { container, rerender } = renderGroup()
        expect(container.querySelector('.animate-pulse')).toBeNull()

        setStreaming()
        rerender(
            <ReasoningGroup>
                <div data-testid="reasoning-content">thinking text</div>
            </ReasoningGroup>
        )
        expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
        expect(isCollapsed(container)).toBe(false)
    })
})

describe('Reasoning', () => {
    it('keeps the typewriter for a newly mounted running reasoning part', () => {
        const view = renderReasoning('Already thought.', 'running')

        expect(screen.getByTestId('reasoning-markdown')).toHaveAttribute('data-smooth', 'true')

        view.rerender(<Reasoning type="reasoning" text="Already thought with more." status={{ type: 'running' }} />)

        expect(screen.getByTestId('reasoning-markdown')).toHaveAttribute('data-smooth', 'true')
    })

    it('does not enable smoothing when completed reasoning is briefly marked running', () => {
        const view = renderReasoning('Already thought.')

        view.rerender(<Reasoning type="reasoning" text="Already thought." status={{ type: 'running' }} />)
        view.rerender(<Reasoning type="reasoning" text="Already thought." status={{ type: 'running' }} />)

        expect(screen.getByTestId('reasoning-markdown')).toHaveAttribute('data-smooth', 'false')
    })

    it('smooths new reasoning when completed reasoning becomes running', () => {
        const view = renderReasoning('Already thought.')

        view.rerender(<Reasoning type="reasoning" text="Already thought with new output." status={{ type: 'running' }} />)

        expect(screen.getByTestId('reasoning-markdown')).toHaveAttribute('data-smooth', 'true')
    })

    it('does not reuse an earlier reasoning stream after the part completes', () => {
        const view = renderReasoning('Already thought.', 'running')

        view.rerender(<Reasoning type="reasoning" text="Already thought with new output." status={{ type: 'running' }} />)
        expect(screen.getByTestId('reasoning-markdown')).toHaveAttribute('data-smooth', 'true')

        view.rerender(<Reasoning type="reasoning" text="Already thought with new output." status={{ type: 'complete' }} />)
        view.rerender(<Reasoning type="reasoning" text="Already thought with new output." status={{ type: 'running' }} />)

        expect(screen.getByTestId('reasoning-markdown')).toHaveAttribute('data-smooth', 'false')
    })
})
