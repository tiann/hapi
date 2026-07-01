import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { getInitialCodeWrap, useCodeWrap } from '@/hooks/useCodeWrap'

const STORAGE_KEY = 'hapi-code-wrap'

describe('useCodeWrap helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to off when nothing is stored', () => {
        expect(getInitialCodeWrap()).toBe(false)
    })

    it('reads a stored "1" as on', () => {
        window.localStorage.setItem(STORAGE_KEY, '1')

        expect(getInitialCodeWrap()).toBe(true)
    })

    it('treats any non-"1" stored value as off', () => {
        window.localStorage.setItem(STORAGE_KEY, 'garbage')

        expect(getInitialCodeWrap()).toBe(false)
    })
})

describe('useCodeWrap', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('starts off by default', () => {
        const { result } = renderHook(() => useCodeWrap())

        expect(result.current.codeWrap).toBe(false)
    })

    it('turning on writes "1" to localStorage and updates state', () => {
        const { result } = renderHook(() => useCodeWrap())

        act(() => {
            result.current.setCodeWrap(true)
        })

        expect(result.current.codeWrap).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1')
    })

    it('turning off removes the localStorage key and updates state', () => {
        window.localStorage.setItem(STORAGE_KEY, '1')
        const { result } = renderHook(() => useCodeWrap())
        expect(result.current.codeWrap).toBe(true)

        act(() => {
            result.current.setCodeWrap(false)
        })

        expect(result.current.codeWrap).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('syncs across instances via the storage event', () => {
        const { result } = renderHook(() => useCodeWrap())
        expect(result.current.codeWrap).toBe(false)

        act(() => {
            window.localStorage.setItem(STORAGE_KEY, '1')
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: '1',
            }))
        })

        expect(result.current.codeWrap).toBe(true)
    })

    it('ignores storage events for unrelated keys', () => {
        const { result } = renderHook(() => useCodeWrap())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'hapi-some-other-key',
                newValue: '1',
            }))
        })

        expect(result.current.codeWrap).toBe(false)
    })

    it('syncs across multiple hook instances in the same tab (e.g. two CodeBlocks)', () => {
        // Same-tab localStorage writes do NOT fire a `storage` event in the
        // same document (the spec only fires it in *other* browsing
        // contexts), so this instance must learn about the toggle through
        // an in-memory channel, not just the storage listener.
        const a = renderHook(() => useCodeWrap())
        const b = renderHook(() => useCodeWrap())

        act(() => {
            a.result.current.setCodeWrap(true)
        })

        expect(a.result.current.codeWrap).toBe(true)
        expect(b.result.current.codeWrap).toBe(true)

        act(() => {
            b.result.current.setCodeWrap(false)
        })

        expect(a.result.current.codeWrap).toBe(false)
        expect(b.result.current.codeWrap).toBe(false)
    })
})
