import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    SCRATCHLIST_ENABLED_STORAGE_KEY,
    readScratchlistEnabledPreference,
    useScratchlistEnabled,
} from './useScratchlistEnabled'

describe('useScratchlistEnabled', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('defaults the scratchlist off so it does not take chat space unless enabled', () => {
        expect(readScratchlistEnabledPreference()).toBe(false)
        const { result } = renderHook(() => useScratchlistEnabled())
        expect(result.current[0]).toBe(false)
    })

    it('persists true and removes storage when reset to the default false value', () => {
        const { result } = renderHook(() => useScratchlistEnabled())

        act(() => result.current[1](true))
        expect(result.current[0]).toBe(true)
        expect(localStorage.getItem(SCRATCHLIST_ENABLED_STORAGE_KEY)).toBe('true')

        act(() => result.current[1](false))
        expect(result.current[0]).toBe(false)
        expect(localStorage.getItem(SCRATCHLIST_ENABLED_STORAGE_KEY)).toBeNull()
    })
})
