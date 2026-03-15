import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLongPress } from './useLongPress'

describe('useLongPress', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('triggers onLongPress after threshold', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500 })
        )

        const mouseEvent = {
            button: 0,
            clientX: 100,
            clientY: 200,
        } as React.MouseEvent

        result.current.onMouseDown(mouseEvent)

        vi.advanceTimersByTime(500)

        expect(onLongPress).toHaveBeenCalledWith({ x: 100, y: 200 })
    })

    it('triggers onClick on short press', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick, threshold: 500 })
        )

        const mouseEvent = {
            button: 0,
            clientX: 100,
            clientY: 200,
        } as React.MouseEvent

        result.current.onMouseDown(mouseEvent)
        vi.advanceTimersByTime(200)
        result.current.onMouseUp({} as React.MouseEvent)

        expect(onLongPress).not.toHaveBeenCalled()
        expect(onClick).toHaveBeenCalled()
    })

    it('does not trigger onClick after long press', () => {
        const onLongPress = vi.fn()
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, onClick, threshold: 500 })
        )

        const mouseEvent = {
            button: 0,
            clientX: 100,
            clientY: 200,
        } as React.MouseEvent

        result.current.onMouseDown(mouseEvent)
        vi.advanceTimersByTime(500)
        result.current.onMouseUp({} as React.MouseEvent)

        expect(onLongPress).toHaveBeenCalled()
        expect(onClick).not.toHaveBeenCalled()
    })

    it('cancels long press on mouse leave', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500 })
        )

        const mouseEvent = {
            button: 0,
            clientX: 100,
            clientY: 200,
        } as React.MouseEvent

        result.current.onMouseDown(mouseEvent)
        vi.advanceTimersByTime(200)
        result.current.onMouseLeave({} as React.MouseEvent)
        vi.advanceTimersByTime(300)

        expect(onLongPress).not.toHaveBeenCalled()
    })

    it('handles touch events', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500 })
        )

        const touchEvent = {
            touches: [{ clientX: 100, clientY: 200 }],
            preventDefault: vi.fn(),
        } as unknown as React.TouchEvent

        result.current.onTouchStart(touchEvent)
        vi.advanceTimersByTime(500)

        expect(onLongPress).toHaveBeenCalledWith({ x: 100, y: 200 })
    })

    it('cancels on touch move', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500 })
        )

        const touchEvent = {
            touches: [{ clientX: 100, clientY: 200 }],
            preventDefault: vi.fn(),
        } as unknown as React.TouchEvent

        result.current.onTouchStart(touchEvent)
        vi.advanceTimersByTime(200)
        result.current.onTouchMove({} as React.TouchEvent)
        vi.advanceTimersByTime(300)

        expect(onLongPress).not.toHaveBeenCalled()
    })

    it('respects disabled option', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500, disabled: true })
        )

        const mouseEvent = {
            button: 0,
            clientX: 100,
            clientY: 200,
        } as React.MouseEvent

        result.current.onMouseDown(mouseEvent)
        vi.advanceTimersByTime(500)

        expect(onLongPress).not.toHaveBeenCalled()
    })

    it('handles context menu', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress })
        )

        const contextMenuEvent = {
            preventDefault: vi.fn(),
            clientX: 150,
            clientY: 250,
        } as unknown as React.MouseEvent

        result.current.onContextMenu(contextMenuEvent)

        expect(contextMenuEvent.preventDefault).toHaveBeenCalled()
        expect(onLongPress).toHaveBeenCalledWith({ x: 150, y: 250 })
    })

    it('handles keyboard events', () => {
        const onClick = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress: vi.fn(), onClick })
        )

        const enterEvent = {
            key: 'Enter',
            preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent

        result.current.onKeyDown(enterEvent)

        expect(enterEvent.preventDefault).toHaveBeenCalled()
        expect(onClick).toHaveBeenCalled()
    })

    it('ignores non-left mouse button', () => {
        const onLongPress = vi.fn()
        const { result } = renderHook(() =>
            useLongPress({ onLongPress, threshold: 500 })
        )

        const mouseEvent = {
            button: 2, // Right click
            clientX: 100,
            clientY: 200,
        } as React.MouseEvent

        result.current.onMouseDown(mouseEvent)
        vi.advanceTimersByTime(500)

        expect(onLongPress).not.toHaveBeenCalled()
    })
})
