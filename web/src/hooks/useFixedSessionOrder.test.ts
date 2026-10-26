import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_FIXED_SESSION_ORDER,
    getInitialFixedSessionOrder,
    useFixedSessionOrder,
} from './useFixedSessionOrder'

const STORAGE_KEY = 'hapi-fixed-session-order'

describe('useFixedSessionOrder helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to off', () => {
        expect(getInitialFixedSessionOrder()).toBe(DEFAULT_FIXED_SESSION_ORDER)
        expect(getInitialFixedSessionOrder()).toBe(false)
    })

    it('reads the stored value and falls back for other values', () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        expect(getInitialFixedSessionOrder()).toBe(true)

        window.localStorage.setItem(STORAGE_KEY, 'invalid')
        expect(getInitialFixedSessionOrder()).toBe(false)
    })
})

describe('useFixedSessionOrder', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('persists changes and synchronizes hook instances in the same tab', () => {
        const first = renderHook(() => useFixedSessionOrder())
        const second = renderHook(() => useFixedSessionOrder())

        act(() => first.result.current.setFixedSessionOrder(true))

        expect(first.result.current.fixedSessionOrder).toBe(true)
        expect(second.result.current.fixedSessionOrder).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')

        act(() => second.result.current.setFixedSessionOrder(false))

        expect(first.result.current.fixedSessionOrder).toBe(false)
        expect(second.result.current.fixedSessionOrder).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('synchronizes changes from another browsing context', () => {
        const { result } = renderHook(() => useFixedSessionOrder())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: 'true',
            }))
        })

        expect(result.current.fixedSessionOrder).toBe(true)
    })

    it('ignores storage events for unrelated keys', () => {
        const { result } = renderHook(() => useFixedSessionOrder())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'hapi-other-setting',
                newValue: 'true',
            }))
        })

        expect(result.current.fixedSessionOrder).toBe(false)
    })
})
