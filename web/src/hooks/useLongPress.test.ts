import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type React from 'react'
import { useLongPress } from './useLongPress'

function pointerEvent(init: Partial<{
    isPrimary: boolean
    pointerType: 'mouse' | 'touch' | 'pen'
    button: number
    clientX: number
    clientY: number
}> = {}): React.PointerEvent {
    return {
        isPrimary: init.isPrimary ?? true,
        pointerType: init.pointerType ?? 'touch',
        button: init.button ?? 0,
        clientX: init.clientX ?? 0,
        clientY: init.clientY ?? 0
    } as unknown as React.PointerEvent
}

describe('useLongPress', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('fires onLongPress after the threshold elapses', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick, threshold: 500 })
        )

        act(() => {
            result.current.onPointerDown(pointerEvent({ clientX: 10, clientY: 20 }))
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })

        expect(onLongPress).toHaveBeenCalledWith({ x: 10, y: 20 })
        expect(onClick).not.toHaveBeenCalled()
    })

    it('fires onClick on pointer up before the threshold', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick, threshold: 500 })
        )

        act(() => {
            result.current.onPointerDown(pointerEvent())
            result.current.onPointerUp(pointerEvent())
        })

        expect(onClick).toHaveBeenCalledTimes(1)
        expect(onLongPress).not.toHaveBeenCalled()
    })

    it('cancels the timer and suppresses click when movement exceeds the threshold', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick, threshold: 500 })
        )

        act(() => {
            result.current.onPointerDown(pointerEvent({ clientX: 0, clientY: 0 }))
            result.current.onPointerMove(pointerEvent({ clientX: 20, clientY: 0 }))
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })
        act(() => {
            result.current.onPointerUp(pointerEvent({ clientX: 20, clientY: 0 }))
        })

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).not.toHaveBeenCalled()
    })

    it('ignores sub-threshold movement', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick, threshold: 500 })
        )

        act(() => {
            result.current.onPointerDown(pointerEvent({ clientX: 0, clientY: 0 }))
            result.current.onPointerMove(pointerEvent({ clientX: 3, clientY: 2 }))
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })

        expect(onLongPress).toHaveBeenCalledTimes(1)
    })

    it('ignores non-primary pointers and non-left mouse buttons', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500 })
        )

        act(() => {
            result.current.onPointerDown(pointerEvent({ isPrimary: false }))
            result.current.onPointerDown(pointerEvent({ pointerType: 'mouse', button: 2 }))
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })

        expect(onLongPress).not.toHaveBeenCalled()
    })

    it('does not start the long-press timer when disabled', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500, disabled: true })
        )

        act(() => {
            result.current.onPointerDown(pointerEvent())
        })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })

        expect(onLongPress).not.toHaveBeenCalled()
    })

    it('ignores keyboard activation when disabled', () => {
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress: vi.fn(), onClick, disabled: true })
        )

        const preventDefault = vi.fn()
        const enter = { key: 'Enter', preventDefault } as unknown as React.KeyboardEvent

        act(() => {
            result.current.onKeyDown(enter)
        })

        expect(onClick).not.toHaveBeenCalled()
        expect(preventDefault).not.toHaveBeenCalled()
    })

    it('cancels on pointer cancel and pointer leave', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick, threshold: 500 })
        )

        act(() => {
            result.current.onPointerDown(pointerEvent())
            result.current.onPointerCancel(pointerEvent())
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).not.toHaveBeenCalled()

        act(() => {
            result.current.onPointerDown(pointerEvent())
            result.current.onPointerLeave(pointerEvent())
        })
        act(() => {
            vi.advanceTimersByTime(500)
        })

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).not.toHaveBeenCalled()
    })

    it('triggers onClick on Enter and Space keys', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick })
        )

        const preventDefault = vi.fn()
        const enter = { key: 'Enter', preventDefault } as unknown as React.KeyboardEvent
        const space = { key: ' ', preventDefault } as unknown as React.KeyboardEvent

        act(() => {
            result.current.onKeyDown(enter)
            result.current.onKeyDown(space)
        })

        expect(onClick).toHaveBeenCalledTimes(2)
        expect(preventDefault).toHaveBeenCalledTimes(2)
    })
})
