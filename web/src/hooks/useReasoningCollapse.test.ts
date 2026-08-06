import { act, renderHook, cleanup } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_REASONING_COLLAPSED,
    getInitialReasoningCollapsed,
    useReasoningCollapse,
} from './useReasoningCollapse'

const STORAGE_KEY = 'hapi-reasoning-collapsed'

describe('useReasoningCollapse helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to expanded', () => {
        expect(getInitialReasoningCollapsed()).toBe(DEFAULT_REASONING_COLLAPSED)
    })

    it('reads valid stored values and ignores invalid values', () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        expect(getInitialReasoningCollapsed()).toBe(true)

        window.localStorage.setItem(STORAGE_KEY, 'invalid')
        expect(getInitialReasoningCollapsed()).toBe(DEFAULT_REASONING_COLLAPSED)
    })
})

describe('useReasoningCollapse', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('persists the collapsed preference', () => {
        const { result } = renderHook(() => useReasoningCollapse())

        act(() => {
            result.current.setReasoningCollapsed(true)
        })

        expect(result.current.reasoningCollapsed).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')
    })

    it('removes the stored preference when restored to the default', () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        const { result } = renderHook(() => useReasoningCollapse())

        act(() => {
            result.current.setReasoningCollapsed(false)
        })

        expect(result.current.reasoningCollapsed).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('keeps the preference in memory when persistence fails', () => {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded')
        })
        const { result } = renderHook(() => useReasoningCollapse())

        act(() => {
            result.current.setReasoningCollapsed(true)
        })

        expect(result.current.reasoningCollapsed).toBe(true)
        setItemSpy.mockRestore()
    })

    it('keeps the preference in memory when removal fails', () => {
        const removeItemSpy = vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
            throw new Error('denied')
        })
        const { result } = renderHook(() => useReasoningCollapse())

        act(() => {
            result.current.setReasoningCollapsed(false)
        })

        expect(result.current.reasoningCollapsed).toBe(false)
        removeItemSpy.mockRestore()
    })

    it('retains the in-memory fallback across later subscriptions when persistence fails', () => {
        const setItemSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded')
        })
        const first = renderHook(() => useReasoningCollapse())

        act(() => {
            first.result.current.setReasoningCollapsed(true)
        })
        expect(first.result.current.reasoningCollapsed).toBe(true)

        // A later-mounted instance must not resync over the in-memory value
        // that storage does not reflect.
        const second = renderHook(() => useReasoningCollapse())
        expect(second.result.current.reasoningCollapsed).toBe(true)
        expect(first.result.current.reasoningCollapsed).toBe(true)

        setItemSpy.mockRestore()
    })

    it('applies cross-tab changes from storage events', () => {
        const { result } = renderHook(() => useReasoningCollapse())

        act(() => {
            window.localStorage.setItem(STORAGE_KEY, 'true')
            window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
        })

        expect(result.current.reasoningCollapsed).toBe(true)

        act(() => {
            window.localStorage.removeItem(STORAGE_KEY)
            window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
        })

        expect(result.current.reasoningCollapsed).toBe(false)
    })

    it('shares a single storage listener across all hook instances', () => {
        cleanup()
        const addSpy = vi.spyOn(window, 'addEventListener')
        const removeSpy = vi.spyOn(window, 'removeEventListener')
        const countStorageListeners = () => {
            const calls = addSpy.mock.calls.filter(([type]) => String(type) === 'storage').length
                - removeSpy.mock.calls.filter(([type]) => String(type) === 'storage').length
            return calls
        }

        const first = renderHook(() => useReasoningCollapse())
        const second = renderHook(() => useReasoningCollapse())
        expect(countStorageListeners()).toBe(1)

        first.unmount()
        expect(countStorageListeners()).toBe(1)

        second.unmount()
        expect(countStorageListeners()).toBe(0)

        addSpy.mockRestore()
        removeSpy.mockRestore()
    })
})
