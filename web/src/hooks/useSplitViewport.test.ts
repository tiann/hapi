import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSplitViewport } from './useSplitViewport'

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

describe('useSplitViewport', () => {
    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it('reports the split-layout match synchronously on first render', () => {
        stubMatchMedia(true)
        const { result } = renderHook(() => useSplitViewport())
        expect(result.current).toBe(true)
    })

    it('reports single-pane viewport synchronously when matchMedia says so', () => {
        stubMatchMedia(false)
        const { result } = renderHook(() => useSplitViewport())
        expect(result.current).toBe(false)
    })

    it('tracks subsequent matchMedia changes', () => {
        const dispatch = stubMatchMedia(false)
        const { result } = renderHook(() => useSplitViewport())
        expect(result.current).toBe(false)
        act(() => {
            dispatch({ matches: true } as MediaQueryListEvent)
        })
        expect(result.current).toBe(true)
    })
})
