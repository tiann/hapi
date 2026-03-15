import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTheme, useAppearance, initializeTheme, getAppearanceOptions } from './useTheme'

describe('getAppearanceOptions', () => {
    it('returns all appearance options', () => {
        const options = getAppearanceOptions()
        expect(options).toHaveLength(3)
        expect(options[0]).toEqual({ value: 'system', labelKey: 'settings.display.appearance.system' })
        expect(options[1]).toEqual({ value: 'dark', labelKey: 'settings.display.appearance.dark' })
        expect(options[2]).toEqual({ value: 'light', labelKey: 'settings.display.appearance.light' })
    })
})

describe('useTheme', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
    })

    it('returns current color scheme', () => {
        const { result } = renderHook(() => useTheme())
        expect(result.current.colorScheme).toMatch(/^(light|dark)$/)
    })

    it('returns isDark based on color scheme', () => {
        const { result } = renderHook(() => useTheme())
        expect(result.current.isDark).toBe(result.current.colorScheme === 'dark')
    })
})

describe('useAppearance', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
    })

    it('initializes with system preference', () => {
        const { result } = renderHook(() => useAppearance())
        expect(result.current.appearance).toBe('system')
    })

    it('loads saved appearance from localStorage', () => {
        localStorage.setItem('zs-appearance', 'dark')
        const { result } = renderHook(() => useAppearance())
        expect(result.current.appearance).toBe('dark')
    })

    it('sets appearance to dark', () => {
        const { result } = renderHook(() => useAppearance())

        act(() => {
            result.current.setAppearance('dark')
        })

        expect(result.current.appearance).toBe('dark')
        expect(localStorage.getItem('zs-appearance')).toBe('dark')
    })

    it('sets appearance to light', () => {
        const { result } = renderHook(() => useAppearance())

        act(() => {
            result.current.setAppearance('light')
        })

        expect(result.current.appearance).toBe('light')
        expect(localStorage.getItem('zs-appearance')).toBe('light')
    })

    it('removes localStorage entry for system preference', () => {
        localStorage.setItem('zs-appearance', 'dark')
        const { result } = renderHook(() => useAppearance())

        act(() => {
            result.current.setAppearance('system')
        })

        expect(result.current.appearance).toBe('system')
        expect(localStorage.getItem('zs-appearance')).toBeNull()
    })

    it('handles invalid localStorage value', () => {
        localStorage.setItem('zs-appearance', 'invalid')
        const { result } = renderHook(() => useAppearance())
        expect(result.current.appearance).toBe('system')
    })

    it('syncs across tabs via storage event', () => {
        const { result } = renderHook(() => useAppearance())

        act(() => {
            const event = new StorageEvent('storage', {
                key: 'zs-appearance',
                newValue: 'dark',
            })
            window.dispatchEvent(event)
        })

        expect(result.current.appearance).toBe('dark')
    })

    it('ignores storage events for other keys', () => {
        const { result } = renderHook(() => useAppearance())
        const initialAppearance = result.current.appearance

        act(() => {
            const event = new StorageEvent('storage', {
                key: 'other-key',
                newValue: 'dark',
            })
            window.dispatchEvent(event)
        })

        expect(result.current.appearance).toBe(initialAppearance)
    })
})

describe('initializeTheme', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
    })

    it('applies theme on initialization', () => {
        initializeTheme()
        const theme = document.documentElement.getAttribute('data-theme')
        expect(theme).toMatch(/^(light|dark)$/)
    })

    it('applies saved appearance on initialization', () => {
        localStorage.setItem('zs-appearance', 'dark')
        initializeTheme()
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })

    it('can be called multiple times safely', () => {
        initializeTheme()
        initializeTheme()
        const theme = document.documentElement.getAttribute('data-theme')
        expect(theme).toMatch(/^(light|dark)$/)
    })
})
