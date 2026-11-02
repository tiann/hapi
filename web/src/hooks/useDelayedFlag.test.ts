import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDelayedFlag } from './useDelayedFlag'

describe('useDelayedFlag', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('reveals only after the value stays true for the delay', () => {
        const { result, rerender } = renderHook(({ value }) => useDelayedFlag(value, 2_000), {
            initialProps: { value: true },
        })
        expect(result.current).toBe(false)
        act(() => { vi.advanceTimersByTime(1_999) })
        expect(result.current).toBe(false)
        act(() => { vi.advanceTimersByTime(1) })
        expect(result.current).toBe(true)

        rerender({ value: false })
        expect(result.current).toBe(false)
    })

    it('never reveals a value that clears before the delay', () => {
        const { result, rerender } = renderHook(({ value }) => useDelayedFlag(value, 2_000), {
            initialProps: { value: true },
        })
        act(() => { vi.advanceTimersByTime(1_500) })
        rerender({ value: false })
        act(() => { vi.advanceTimersByTime(5_000) })
        expect(result.current).toBe(false)

        rerender({ value: true })
        act(() => { vi.advanceTimersByTime(1_500) })
        expect(result.current).toBe(false)
    })
})
