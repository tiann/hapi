import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOnlineStatus } from './useOnlineStatus'

describe('useOnlineStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns initial online status', () => {
        Object.defineProperty(navigator, 'onLine', {
            writable: true,
            value: true,
        })

        const { result } = renderHook(() => useOnlineStatus())
        expect(result.current).toBe(true)
    })

    it('returns false when offline', () => {
        Object.defineProperty(navigator, 'onLine', {
            writable: true,
            value: false,
        })

        const { result } = renderHook(() => useOnlineStatus())
        expect(result.current).toBe(false)
    })

    it('updates when going online', () => {
        Object.defineProperty(navigator, 'onLine', {
            writable: true,
            value: false,
        })

        const { result } = renderHook(() => useOnlineStatus())
        expect(result.current).toBe(false)

        act(() => {
            Object.defineProperty(navigator, 'onLine', {
                writable: true,
                value: true,
            })
            window.dispatchEvent(new Event('online'))
        })

        expect(result.current).toBe(true)
    })

    it('updates when going offline', () => {
        Object.defineProperty(navigator, 'onLine', {
            writable: true,
            value: true,
        })

        const { result } = renderHook(() => useOnlineStatus())
        expect(result.current).toBe(true)

        act(() => {
            Object.defineProperty(navigator, 'onLine', {
                writable: true,
                value: false,
            })
            window.dispatchEvent(new Event('offline'))
        })

        expect(result.current).toBe(false)
    })

    it('cleans up event listeners on unmount', () => {
        const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
        const { unmount } = renderHook(() => useOnlineStatus())

        unmount()

        expect(removeEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function))
        expect(removeEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function))
    })
})
