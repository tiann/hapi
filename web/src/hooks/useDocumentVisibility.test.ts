import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDocumentVisibility } from './useDocumentVisibility'

function setVisibilityState(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: state,
    })
}

afterEach(() => {
    setVisibilityState('visible')
})

describe('useDocumentVisibility', () => {
    it('reads the current document visibility synchronously', () => {
        setVisibilityState('hidden')
        const { result } = renderHook(() => useDocumentVisibility())

        expect(result.current).toBe(false)
    })

    it('tracks visibility changes', () => {
        setVisibilityState('visible')
        const { result } = renderHook(() => useDocumentVisibility())
        expect(result.current).toBe(true)

        setVisibilityState('hidden')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        expect(result.current).toBe(false)

        setVisibilityState('visible')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        expect(result.current).toBe(true)
    })
})
