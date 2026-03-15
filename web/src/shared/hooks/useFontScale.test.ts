import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFontScale, getFontScaleOptions, initializeFontScale, type FontScale } from './useFontScale'

describe('getFontScaleOptions', () => {
    it('returns all font scale options', () => {
        const options = getFontScaleOptions()
        expect(options).toHaveLength(5)
        expect(options[0]).toEqual({ value: 0.8, label: '80%' })
        expect(options[2]).toEqual({ value: 1, label: '100%' })
        expect(options[4]).toEqual({ value: 1.2, label: '120%' })
    })
})

describe('useFontScale', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        document.documentElement.style.removeProperty('--app-font-scale')
    })

    it('initializes with default scale of 1', () => {
        const { result } = renderHook(() => useFontScale())
        expect(result.current.fontScale).toBe(1)
    })

    it('loads saved scale from localStorage', () => {
        localStorage.setItem('zs-font-scale', '1.2')
        const { result } = renderHook(() => useFontScale())
        expect(result.current.fontScale).toBe(1.2)
    })

    it('applies font scale to CSS variable', () => {
        const { result } = renderHook(() => useFontScale())

        act(() => {
            result.current.setFontScale(1.1)
        })

        expect(document.documentElement.style.getPropertyValue('--app-font-scale')).toBe('1.1')
    })

    it('saves non-default scale to localStorage', () => {
        const { result } = renderHook(() => useFontScale())

        act(() => {
            result.current.setFontScale(0.9)
        })

        expect(localStorage.getItem('zs-font-scale')).toBe('0.9')
    })

    it('removes localStorage entry for default scale', () => {
        localStorage.setItem('zs-font-scale', '1.2')
        const { result } = renderHook(() => useFontScale())

        act(() => {
            result.current.setFontScale(1)
        })

        expect(localStorage.getItem('zs-font-scale')).toBeNull()
    })

    it('handles invalid localStorage value', () => {
        localStorage.setItem('zs-font-scale', 'invalid')
        const { result } = renderHook(() => useFontScale())
        expect(result.current.fontScale).toBe(1)
    })

    it('handles out-of-range values', () => {
        localStorage.setItem('zs-font-scale', '2.5')
        const { result } = renderHook(() => useFontScale())
        expect(result.current.fontScale).toBe(1)
    })

    it('syncs across tabs via storage event', () => {
        const { result } = renderHook(() => useFontScale())

        act(() => {
            const event = new StorageEvent('storage', {
                key: 'zs-font-scale',
                newValue: '0.8',
            })
            window.dispatchEvent(event)
        })

        expect(result.current.fontScale).toBe(0.8)
    })

    it('ignores storage events for other keys', () => {
        const { result } = renderHook(() => useFontScale())
        const initialScale = result.current.fontScale

        act(() => {
            const event = new StorageEvent('storage', {
                key: 'other-key',
                newValue: '1.2',
            })
            window.dispatchEvent(event)
        })

        expect(result.current.fontScale).toBe(initialScale)
    })
})

describe('initializeFontScale', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.style.removeProperty('--app-font-scale')
    })

    it('applies default scale on initialization', () => {
        initializeFontScale()
        expect(document.documentElement.style.getPropertyValue('--app-font-scale')).toBe('1')
    })

    it('applies saved scale on initialization', () => {
        localStorage.setItem('zs-font-scale', '1.2')
        initializeFontScale()
        expect(document.documentElement.style.getPropertyValue('--app-font-scale')).toBe('1.2')
    })
})
