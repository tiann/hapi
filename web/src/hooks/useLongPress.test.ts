import type React from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from './useLongPress'

function makeTouchStartEvent(point = { x: 20, y: 40 }): React.TouchEvent {
    return {
        touches: [{ clientX: point.x, clientY: point.y }]
    } as unknown as React.TouchEvent
}

function makeTouchEndEvent() {
    const preventDefault = vi.fn()
    const event = { preventDefault } as unknown as React.TouchEvent
    return { event, preventDefault }
}

describe('useLongPress', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.runOnlyPendingTimers()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('calls preventDefault on touchend for normal taps', () => {
        const { result } = renderHook(() => useLongPress({
            onLongPress: vi.fn(),
            onClick: vi.fn()
        }))
        const { event, preventDefault } = makeTouchEndEvent()

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent())
            result.current.onTouchEnd(event)
        })

        expect(preventDefault).toHaveBeenCalledTimes(1)
    })

    it('calls preventDefault on touchend after long press', () => {
        const { result } = renderHook(() => useLongPress({
            onLongPress: vi.fn(),
            onClick: vi.fn()
        }))
        const { event, preventDefault } = makeTouchEndEvent()

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent())
            vi.advanceTimersByTime(500)
            result.current.onTouchEnd(event)
        })

        expect(preventDefault).toHaveBeenCalledTimes(1)
    })

    it('calls preventDefault on touchend after touch move', () => {
        const { result } = renderHook(() => useLongPress({
            onLongPress: vi.fn(),
            onClick: vi.fn()
        }))
        const { event, preventDefault } = makeTouchEndEvent()

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent())
            result.current.onTouchMove({} as unknown as React.TouchEvent)
            result.current.onTouchEnd(event)
        })

        expect(preventDefault).toHaveBeenCalledTimes(1)
    })

    it('fires onClick once on normal tap', () => {
        const onClick = vi.fn()
        const { result } = renderHook(() => useLongPress({
            onLongPress: vi.fn(),
            onClick
        }))

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent())
            result.current.onTouchEnd(makeTouchEndEvent().event)
        })

        expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('does not fire onClick when touch moved', () => {
        const onClick = vi.fn()
        const { result } = renderHook(() => useLongPress({
            onLongPress: vi.fn(),
            onClick
        }))

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent())
            result.current.onTouchMove({} as unknown as React.TouchEvent)
            result.current.onTouchEnd(makeTouchEndEvent().event)
        })

        expect(onClick).not.toHaveBeenCalled()
    })

    it('fires onLongPress and not onClick for long press', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() => useLongPress({
            onLongPress,
            onClick
        }))

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent({ x: 11, y: 22 }))
            vi.advanceTimersByTime(500)
            result.current.onTouchEnd(makeTouchEndEvent().event)
        })

        expect(onLongPress).toHaveBeenCalledTimes(1)
        expect(onLongPress).toHaveBeenCalledWith({ x: 11, y: 22 })
        expect(onClick).not.toHaveBeenCalled()
    })

    it('keeps mouse click behavior unchanged', () => {
        const onClick = vi.fn()
        const { result } = renderHook(() => useLongPress({
            onLongPress: vi.fn(),
            onClick
        }))

        act(() => {
            result.current.onMouseDown({ button: 0, clientX: 1, clientY: 2 } as unknown as React.MouseEvent)
            result.current.onMouseUp({} as unknown as React.MouseEvent)
        })

        expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('keeps keyboard Enter behavior unchanged', () => {
        const onClick = vi.fn()
        const preventDefault = vi.fn()
        const { result } = renderHook(() => useLongPress({
            onLongPress: vi.fn(),
            onClick
        }))

        act(() => {
            result.current.onKeyDown({ key: 'Enter', preventDefault } as unknown as React.KeyboardEvent)
        })

        expect(preventDefault).toHaveBeenCalledTimes(1)
        expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('clears pending timer on touchcancel', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() => useLongPress({
            onLongPress,
            onClick: vi.fn()
        }))

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent())
            result.current.onTouchCancel({} as unknown as React.TouchEvent)
            vi.advanceTimersByTime(500)
        })

        expect(onLongPress).not.toHaveBeenCalled()
    })

    it('clears pending timer on unmount', () => {
        const onLongPress = vi.fn()
        const { result, unmount } = renderHook(() => useLongPress({
            onLongPress,
            onClick: vi.fn()
        }))

        act(() => {
            result.current.onTouchStart(makeTouchStartEvent())
        })

        unmount()

        act(() => {
            vi.advanceTimersByTime(500)
        })

        expect(onLongPress).not.toHaveBeenCalled()
    })
})
