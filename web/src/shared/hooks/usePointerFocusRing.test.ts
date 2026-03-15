import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePointerFocusRing } from './usePointerFocusRing'

describe('usePointerFocusRing', () => {
    it('initializes with suppressFocusRing as false', () => {
        const { result } = renderHook(() => usePointerFocusRing())
        expect(result.current.suppressFocusRing).toBe(false)
    })

    it('sets suppressFocusRing to true on pointer down', () => {
        const { result } = renderHook(() => usePointerFocusRing())

        act(() => {
            result.current.onTriggerPointerDown({} as React.PointerEvent<HTMLElement>)
        })

        expect(result.current.suppressFocusRing).toBe(true)
    })

    it('sets suppressFocusRing to false on key down', () => {
        const { result } = renderHook(() => usePointerFocusRing())

        act(() => {
            result.current.onTriggerPointerDown({} as React.PointerEvent<HTMLElement>)
        })

        expect(result.current.suppressFocusRing).toBe(true)

        act(() => {
            result.current.onTriggerKeyDown({} as React.KeyboardEvent<HTMLElement>)
        })

        expect(result.current.suppressFocusRing).toBe(false)
    })

    it('sets suppressFocusRing to false on blur', () => {
        const { result } = renderHook(() => usePointerFocusRing())

        act(() => {
            result.current.onTriggerPointerDown({} as React.PointerEvent<HTMLElement>)
        })

        expect(result.current.suppressFocusRing).toBe(true)

        act(() => {
            result.current.onTriggerBlur({} as React.FocusEvent<HTMLElement>)
        })

        expect(result.current.suppressFocusRing).toBe(false)
    })

    it('handles multiple pointer down events', () => {
        const { result } = renderHook(() => usePointerFocusRing())

        act(() => {
            result.current.onTriggerPointerDown({} as React.PointerEvent<HTMLElement>)
            result.current.onTriggerPointerDown({} as React.PointerEvent<HTMLElement>)
        })

        expect(result.current.suppressFocusRing).toBe(true)
    })
})
