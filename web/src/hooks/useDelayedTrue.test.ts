import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDelayedTrue } from './useDelayedTrue'

describe('useDelayedTrue', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('stays false until the value has been true for the full delay', () => {
        const { result, rerender } = renderHook(
            ({ value }: { value: boolean }) => useDelayedTrue(value, 3000),
            { initialProps: { value: false } }
        )

        expect(result.current).toBe(false)

        rerender({ value: true })
        expect(result.current).toBe(false)

        act(() => { vi.advanceTimersByTime(2900) })
        expect(result.current).toBe(false)

        act(() => { vi.advanceTimersByTime(200) })
        expect(result.current).toBe(true)
    })

    it('resets immediately when the value turns false', () => {
        const { result, rerender } = renderHook(
            ({ value }: { value: boolean }) => useDelayedTrue(value, 3000),
            { initialProps: { value: true } }
        )

        act(() => { vi.advanceTimersByTime(3100) })
        expect(result.current).toBe(true)

        rerender({ value: false })
        expect(result.current).toBe(false)
    })

    it('cancels a pending delay when the value flaps', () => {
        const { result, rerender } = renderHook(
            ({ value }: { value: boolean }) => useDelayedTrue(value, 3000),
            { initialProps: { value: true } }
        )

        act(() => { vi.advanceTimersByTime(1000) })
        rerender({ value: false })
        act(() => { vi.advanceTimersByTime(5000) })

        expect(result.current).toBe(false)
    })
})
