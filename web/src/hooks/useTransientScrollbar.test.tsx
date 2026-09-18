import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    TRANSIENT_SCROLLBAR_HIDE_DELAY_MS,
    TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE,
    useTransientScrollbar
} from './useTransientScrollbar'
import { useRef, type PropsWithChildren } from 'react'

function ScrollableSurface(props: PropsWithChildren) {
    const ref = useRef<HTMLDivElement>(null)
    useTransientScrollbar(ref)
    return <div ref={ref}>{props.children}</div>
}

function renderSurface() {
    const result = render(
        <ScrollableSurface>
            <button type="button">Focus me</button>
        </ScrollableSurface>
    )
    const surface = result.container.firstElementChild
    if (!(surface instanceof HTMLElement)) {
        throw new Error('Scrollable surface was not rendered')
    }
    const button = surface.querySelector('button')
    if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Scrollable surface focus target was not rendered')
    }
    return { ...result, surface, button }
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
})

describe('useTransientScrollbar', () => {
    it('shows on mount and hides after one second without scrolling', () => {
        const { surface } = renderSurface()

        expect(surface).toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE, 'true')

        act(() => {
            vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS - 1)
        })
        expect(surface).toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE, 'true')

        act(() => {
            vi.advanceTimersByTime(1)
        })
        expect(surface).not.toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE)
    })

    it('resets the idle timer whenever the surface scrolls', () => {
        const { surface } = renderSurface()

        act(() => {
            vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS)
        })
        expect(surface).not.toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE)

        fireEvent.scroll(surface)
        expect(surface).toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE, 'true')

        act(() => {
            vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS - 1)
        })
        expect(surface).toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE, 'true')

        act(() => {
            vi.advanceTimersByTime(1)
        })
        expect(surface).not.toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE)
    })

    it('keeps the scrollbar visible while the surface or a child has focus', () => {
        const { surface, button } = renderSurface()

        act(() => {
            vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS)
        })
        expect(surface).not.toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE)

        fireEvent.focus(button)
        expect(surface).toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE, 'true')

        act(() => {
            vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS * 2)
        })
        expect(surface).toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE, 'true')

        fireEvent.blur(button)
        act(() => {
            vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS)
        })
        expect(surface).not.toHaveAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE)
    })
})
