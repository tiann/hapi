import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECONNECTING_BANNER_DELAY_MS, useReconnectingState } from './useReconnectingState'

describe('useReconnectingState', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('starts out connected', () => {
        const { result } = renderHook(() => useReconnectingState())

        expect(result.current.isReconnecting).toBe(false)
        expect(result.current.reason).toBeNull()
    })

    it('stays quiet while the browser silently reconnects', () => {
        // EventSource fires onerror while it retries on its own, typically
        // recovering within a few seconds. Flashing a full-width banner for
        // that reads as "the network is broken" when nothing was lost.
        const { result } = renderHook(() => useReconnectingState())

        act(() => result.current.reportDisconnect('error'))
        expect(result.current.isReconnecting).toBe(false)

        act(() => {
            vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS - 1)
        })
        expect(result.current.isReconnecting).toBe(false)

        act(() => result.current.reportConnect())
        act(() => {
            vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS)
        })
        expect(result.current.isReconnecting).toBe(false)
    })

    it('surfaces the banner once the outage outlasts the grace period', () => {
        const { result } = renderHook(() => useReconnectingState())

        act(() => result.current.reportDisconnect('heartbeat-timeout'))
        act(() => {
            vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS)
        })

        expect(result.current.isReconnecting).toBe(true)
        expect(result.current.reason).toBe('heartbeat-timeout')
    })

    it('keeps the first reason when further disconnects arrive', () => {
        const { result } = renderHook(() => useReconnectingState())

        act(() => result.current.reportDisconnect('error'))
        act(() => result.current.reportDisconnect('closed'))
        act(() => {
            vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS)
        })

        expect(result.current.isReconnecting).toBe(true)
        expect(result.current.reason).toBe('error')
    })

    it('clears the banner as soon as the stream comes back', () => {
        const { result } = renderHook(() => useReconnectingState())

        act(() => result.current.reportDisconnect('error'))
        act(() => {
            vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS)
        })
        expect(result.current.isReconnecting).toBe(true)

        act(() => result.current.reportConnect())
        expect(result.current.isReconnecting).toBe(false)
        expect(result.current.reason).toBeNull()
    })

    it('drops a pending banner when the hook unmounts', () => {
        const { result, unmount } = renderHook(() => useReconnectingState())

        act(() => result.current.reportDisconnect('error'))
        unmount()

        expect(() => {
            vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS)
        }).not.toThrow()
    })
})
