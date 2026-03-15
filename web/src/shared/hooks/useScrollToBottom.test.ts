import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useScrollToBottom } from './useScrollToBottom'

describe('useScrollToBottom', () => {
    let mockElement: HTMLDivElement

    beforeEach(() => {
        mockElement = document.createElement('div')
        Object.defineProperties(mockElement, {
            scrollHeight: { value: 1000, writable: true, configurable: true },
            scrollTop: { value: 0, writable: true, configurable: true },
            clientHeight: { value: 500, writable: true, configurable: true },
        })
        mockElement.scrollTo = vi.fn()
    })

    it('returns a ref object', () => {
        const { result } = renderHook(() => useScrollToBottom([]))
        expect(result.current).toHaveProperty('current')
    })

    it('scrolls to bottom when deps change and near bottom', () => {
        const { result, rerender } = renderHook(
            ({ deps }) => useScrollToBottom(deps),
            { initialProps: { deps: [1] } }
        )

        result.current.current = mockElement

        // Simulate being near bottom (within default 120px threshold)
        Object.defineProperty(mockElement, 'scrollTop', { value: 880, writable: true, configurable: true })
        mockElement.dispatchEvent(new Event('scroll'))

        rerender({ deps: [2] })

        expect(mockElement.scrollTo).toHaveBeenCalledWith({ top: 1000 })
    })

    it('respects custom threshold', () => {
        const { result, rerender } = renderHook(
            ({ deps }) => useScrollToBottom(deps, { thresholdPx: 50 }),
            { initialProps: { deps: [1] } }
        )

        result.current.current = mockElement

        // Within 50px threshold
        Object.defineProperty(mockElement, 'scrollTop', { value: 940, writable: true, configurable: true })
        mockElement.dispatchEvent(new Event('scroll'))

        rerender({ deps: [2] })

        expect(mockElement.scrollTo).toHaveBeenCalledWith({ top: 1000 })
    })

    it('handles null ref gracefully', () => {
        const { rerender } = renderHook(
            ({ deps }) => useScrollToBottom(deps),
            { initialProps: { deps: [1] } }
        )

        expect(() => rerender({ deps: [2] })).not.toThrow()
    })
})
