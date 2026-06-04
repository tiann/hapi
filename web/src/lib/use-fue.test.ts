import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFue, useFue } from './use-fue'

const FEATURE = 'test-feature'
const STORAGE_KEY = `hapi.fue.v1.${FEATURE}`

describe('useFue', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('starts unseen for new features', () => {
        const { result } = renderHook(() => useFue(FEATURE))
        expect(result.current.status).toBe('unseen')
    })

    it('reads acknowledged state from localStorage on mount', () => {
        localStorage.setItem(STORAGE_KEY, '1')
        const { result } = renderHook(() => useFue(FEATURE))
        expect(result.current.status).toBe('acknowledged')
    })

    it('engage() flips status to engaging once', () => {
        const { result } = renderHook(() => useFue(FEATURE))
        act(() => {
            result.current.engage()
        })
        expect(result.current.status).toBe('engaging')
        // Re-engage is a no-op (does not flip back).
        act(() => {
            result.current.engage()
        })
        expect(result.current.status).toBe('engaging')
    })

    it('does NOT auto-acknowledge — engaging persists until dismiss is called', () => {
        const { result } = renderHook(() => useFue(FEATURE))
        act(() => {
            result.current.engage()
        })
        // Advance the clock far past any plausible timeout.
        act(() => {
            vi.advanceTimersByTime(60_000)
        })
        expect(result.current.status).toBe('engaging')
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('dismiss() acknowledges and persists', () => {
        const { result } = renderHook(() => useFue(FEATURE))
        act(() => {
            result.current.engage()
        })
        act(() => {
            result.current.dismiss()
        })
        expect(result.current.status).toBe('acknowledged')
        expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
    })

    it('dismiss() also works directly from unseen (caller may skip the engaging step)', () => {
        const { result } = renderHook(() => useFue(FEATURE))
        act(() => {
            result.current.dismiss()
        })
        expect(result.current.status).toBe('acknowledged')
        expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
    })

    it('engage() is a no-op once acknowledged', () => {
        localStorage.setItem(STORAGE_KEY, '1')
        const { result } = renderHook(() => useFue(FEATURE))
        act(() => {
            result.current.engage()
        })
        expect(result.current.status).toBe('acknowledged')
    })

    it('resetFue() clears storage so the badge re-appears', () => {
        localStorage.setItem(STORAGE_KEY, '1')
        resetFue(FEATURE)
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
        const { result } = renderHook(() => useFue(FEATURE))
        expect(result.current.status).toBe('unseen')
    })

    it('switches state when featureId changes', () => {
        localStorage.setItem('hapi.fue.v1.feature-a', '1')
        const { result, rerender } = renderHook(
            ({ id }: { id: string }) => useFue(id),
            { initialProps: { id: 'feature-a' } }
        )
        expect(result.current.status).toBe('acknowledged')
        rerender({ id: 'feature-b' })
        expect(result.current.status).toBe('unseen')
    })
})
