import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNarrowViewport } from './useNarrowViewport'

function stubMatchMedia(matches: boolean) {
    let currentMatches = matches
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const dispatch = (event: MediaQueryListEvent) => {
        currentMatches = event.matches
        listeners.forEach((listener) => listener(event))
        return true
    }
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        get matches() {
            return currentMatches
        },
        media: query,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.add(listener)
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.delete(listener)
        },
        dispatchEvent: dispatch,
    })))
    return dispatch
}

describe('useNarrowViewport', () => {
    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it('reports the match synchronously on first render (no wide-toolbar first paint)', () => {
        stubMatchMedia(true)
        const { result } = renderHook(() => useNarrowViewport())
        expect(result.current).toBe(true)
    })

    it('reports wide viewport synchronously when matchMedia says so', () => {
        stubMatchMedia(false)
        const { result } = renderHook(() => useNarrowViewport())
        expect(result.current).toBe(false)
    })

    it('tracks subsequent matchMedia changes', () => {
        const dispatch = stubMatchMedia(false)
        const { result } = renderHook(() => useNarrowViewport())
        expect(result.current).toBe(false)
        act(() => {
            dispatch({ matches: true } as MediaQueryListEvent)
        })
        expect(result.current).toBe(true)
    })
})
