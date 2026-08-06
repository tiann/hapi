import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import React from 'react'

// ReasoningGroup consumes `useMessage` from assistant-ui. Mock it so the
// message status/content can be controlled per test.
const { mockMessage } = vi.hoisted(() => ({
    mockMessage: {
        status: null as { type: string } | null,
        content: [] as { type: string }[],
    },
}))

vi.mock('@assistant-ui/react', () => ({
    useMessage: () => mockMessage,
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
    })

    it('is collapsed by default', () => {
        const { container } = renderGroup()
        expect(isCollapsed(container)).toBe(true)
    })

    it('expands on click', () => {
        const { container } = renderGroup()
        fireEvent.click(container.querySelector('button')!)
        expect(isCollapsed(container)).toBe(false)
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

        act(() => {
            window.localStorage.setItem(STORAGE_KEY, 'true')
            window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
        })

        expect(isCollapsed(container)).toBe(true)
    })
})
