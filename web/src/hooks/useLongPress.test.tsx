import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useLongPress } from './useLongPress'

function Probe(props: { onClick: () => void; onLongPress?: () => void }) {
    const handlers = useLongPress({
        onClick: props.onClick,
        onLongPress: props.onLongPress ?? (() => {}),
    })
    return (
        <button type="button" data-testid="row" {...handlers}>
            row
        </button>
    )
}

function NativeButtonProbe(props: {
    onClick: () => void
    onLongPress: () => void
    longPressEnabled?: boolean
}) {
    const handlers = useLongPress({
        onClick: props.onClick,
        onLongPress: props.onLongPress,
        interaction: 'touch-only-native-click',
        longPressEnabled: props.longPressEnabled,
    })
    return (
        <button type="button" data-testid="native-button" {...handlers}>
            send
        </button>
    )
}

describe('useLongPress', () => {
    let now = 10_000

    beforeEach(() => {
        vi.useFakeTimers()
        // Start well past the ghost-mouse window so a plain mouse tap (no prior
        // touch, lastTouchAt = 0) is not mistaken for a touch-synthesized event.
        now = 10_000
        vi.spyOn(Date, 'now').mockImplementation(() => now)
    })

    afterEach(() => {
        cleanup()
        vi.useRealTimers()
    })

    it('fires onClick once for a mouse tap', () => {
        const onClick = vi.fn()
        const { getByTestId } = render(<Probe onClick={onClick} />)
        const row = getByTestId('row')

        fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseUp(row, { button: 0, clientX: 10, clientY: 10 })

        expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('fires onClick once for a touch tap (ignores the browser-synthesized mouse events that follow)', () => {
        // Real touch browsers (Android Chrome, etc.) emit a compatibility
        // mousedown/mouseup/click ~300ms after touchend for any touch the page
        // did not preventDefault. Because useLongPress binds BOTH touch and
        // mouse handlers, those synthesized events must not trigger a second
        // onClick — otherwise a tap navigates twice (and the second navigation
        // lands on whatever row slid under the finger meanwhile).
        const onClick = vi.fn()
        const { getByTestId } = render(<Probe onClick={onClick} />)
        const row = getByTestId('row')

        fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
        const touchEndPrevented = !fireEvent.touchEnd(row, { changedTouches: [{ clientX: 10, clientY: 10 }] })

        // Browser-synthesized compatibility mouse events for the same tap,
        // ~300ms later.
        act(() => {
            now += 300
            vi.advanceTimersByTime(300)
        })
        fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseUp(row, { button: 0, clientX: 10, clientY: 10 })

        expect(touchEndPrevented).toBe(true)
        expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('does not fire onClick when the touch moved (scroll gesture)', () => {
        const onClick = vi.fn()
        const { getByTestId } = render(<Probe onClick={onClick} />)
        const row = getByTestId('row')

        fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.touchMove(row, { touches: [{ clientX: 10, clientY: 40 }] })
        fireEvent.touchEnd(row, { changedTouches: [{ clientX: 10, clientY: 40 }] })

        expect(onClick).not.toHaveBeenCalled()
    })

    it('still fires onLongPress (and not onClick) for a touch long-press', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<Probe onClick={onClick} onLongPress={onLongPress} />)
        const row = getByTestId('row')

        fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.touchEnd(row, { changedTouches: [{ clientX: 10, clientY: 10 }] })

        expect(onLongPress).toHaveBeenCalledTimes(1)
        expect(onClick).not.toHaveBeenCalled()
    })

    it('still honors a genuine mouse click well after a touch', () => {
        const onClick = vi.fn()
        const { getByTestId } = render(<Probe onClick={onClick} />)
        const row = getByTestId('row')

        // A touch interaction happens first.
        fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.touchEnd(row, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        expect(onClick).toHaveBeenCalledTimes(1)

        // Much later, a real mouse interaction must still work (hybrid devices).
        act(() => {
            now += 1_000
            vi.advanceTimersByTime(1_000)
        })
        fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseUp(row, { button: 0, clientX: 10, clientY: 10 })

        expect(onClick).toHaveBeenCalledTimes(2)
    })

    it('keeps native button click semantics for a touch tap', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.click(button)

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('fires a touch-only long press once and consumes exactly its following touch-derived click', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        // A browser compatibility click has click detail 1. Keyboard and
        // assistive activation instead reports detail 0.
        fireEvent.click(button, { detail: 1 })

        expect(onLongPress).toHaveBeenCalledOnce()
        expect(onClick).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)

        // Only the touch compatibility click is suppressed. The next ordinary
        // click is the button's normal action.
        fireEvent.click(button, { detail: 1 })
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('keeps keyboard and assistive native activation after a long touch with no compatibility click', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })

        // No compatibility click arrives. A detail-zero native click models
        // keyboard or assistive-technology activation and must not be lost.
        fireEvent.click(button, { detail: 0 })

        expect(onLongPress).toHaveBeenCalledOnce()
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('expires native touch-click suppression so later mouse click and context menu stay native', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })

        // No compatibility click arrives during the bounded suppression window.
        act(() => {
            now += 700
            vi.advanceTimersByTime(700)
        })
        const contextMenuWasNotPrevented = fireEvent.contextMenu(button, { clientX: 10, clientY: 10 })
        fireEvent.click(button, { detail: 1 })

        expect(onLongPress).toHaveBeenCalledOnce()
        expect(contextMenuWasNotPrevented).toBe(true)
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('clears pending native click suppression when a new touch is cancelled', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })

        // A new touch clears the old long-touch suppression; cancellation also
        // clears the new touch's hold timer before any native click arrives.
        fireEvent.touchStart(button, { touches: [{ clientX: 20, clientY: 20 }] })
        fireEvent.touchCancel(button)
        fireEvent.click(button, { detail: 1 })

        expect(onLongPress).toHaveBeenCalledOnce()
        expect(onClick).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cleans the pending native click suppression timer on unmount', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId, unmount } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        expect(vi.getTimerCount()).toBe(1)

        unmount()

        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not turn desktop hold or right-click into a touch-only long press', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.mouseDown(button, { button: 0, clientX: 10, clientY: 10 })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.mouseUp(button, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.click(button)
        const contextMenuWasNotPrevented = fireEvent.contextMenu(button, { clientX: 10, clientY: 10 })

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).toHaveBeenCalledOnce()
        expect(contextMenuWasNotPrevented).toBe(true)
    })

    it('can disable only the long-press override without disabling normal click', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(
            <NativeButtonProbe onClick={onClick} onLongPress={onLongPress} longPressEnabled={false} />,
        )
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.click(button)

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('cancels a touch-only long press when the browser cancels the touch', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        const { getByTestId } = render(<NativeButtonProbe onClick={onClick} onLongPress={onLongPress} />)
        const button = getByTestId('native-button')

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.touchCancel(button)
        act(() => {
            now += 500
            vi.advanceTimersByTime(500)
        })
        fireEvent.click(button)

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).toHaveBeenCalledOnce()
    })
})
