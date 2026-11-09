// Regression coverage for tiann/hapi#2335.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZoomableLightbox, type ZoomableLightboxProps } from './ZoomableLightbox'

const close = vi.fn()
function viewer(patch: Partial<ZoomableLightboxProps> = {}) {
    return <ZoomableLightbox open onClose={close} ariaLabel="Image" fitContentKey="image-a"
        fitContentSize={{ width: 400, height: 700 }} {...patch}>
        <svg role="img" aria-label="Content" width="400" height="700" viewBox="0 0 400 700" />
    </ZoomableLightbox>
}
function settleFit() {
    act(() => { vi.advanceTimersByTime(300) })
}
function content() { return screen.getByRole('img', { name: 'Content' }).parentElement! }
function drag() {
    const canvas = content().parentElement!
    Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn(), configurable: true })
    for (const [type, x, y] of [['pointerdown', 100, 100], ['pointermove', 180, 140], ['pointerup', 180, 140]] as const) {
        const event = new Event(type, { bubbles: true })
        Object.defineProperties(event, {
            pointerId: { value: 1 }, button: { value: 0 }, clientX: { value: x }, clientY: { value: y },
        })
        fireEvent(canvas, event)
    }
}
function interact() {
    fireEvent.click(within(screen.getByRole('dialog')).getByTitle('Zoom in', { exact: true }))
    drag()
    return content().style.transform
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('ZoomableLightbox view state', () => {
    it.each([true, false])('preserves pan and zoom for equal dimensions on repeated parent renders (fitOnOpen=%s)', fitOnOpen => {
        const view = render(viewer({ fitOnOpen }))
        settleFit()
        const moved = interact()
        for (let tick = 0; tick < 3; tick++) {
            view.rerender(viewer({ fitOnOpen, fitContentSize: { width: 400, height: 700 }, title: 'Update ' + tick }))
            settleFit()
            expect(content().style.transform).toBe(moved)
        }
    })
    it.each([{ width: 800, height: 700 }, { width: 400, height: 1400 }])('refits for changed dimensions %j', fitContentSize => {
        const view = render(viewer())
        settleFit()
        const moved = interact()
        view.rerender(viewer({ fitContentSize }))
        settleFit()
        expect(content().style.transform).not.toBe(moved)
        expect(content().style.transform).toContain('0px')
    })
    it('refits for a new content key and resets explicitly', () => {
        const view = render(viewer())
        settleFit()
        const moved = interact()
        view.rerender(viewer({ fitContentKey: 'image-b' }))
        settleFit()
        expect(content().style.transform).not.toBe(moved)
        const initial = content().style.transform
        interact()
        fireEvent.click(screen.getByTitle('Fit to screen', { exact: true }))
        expect(content().style.transform).toBe(initial)
    })
    it('fits when asynchronous dimensions arrive and again on reopening', () => {
        const view = render(viewer({ fitContentKey: null, fitContentSize: null }))
        settleFit()
        view.rerender(viewer())
        settleFit()
        const initial = content().style.transform
        interact()
        view.rerender(viewer({ open: false }))
        expect(screen.queryByRole('dialog')).toBeNull()
        view.rerender(viewer())
        settleFit()
        expect(content().style.transform).toBe(initial)
    })
})
