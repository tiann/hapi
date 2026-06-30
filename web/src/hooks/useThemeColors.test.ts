import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    applyThemeColors,
    disposeThemeColors,
    initializeThemeColors,
    THEME_COLOR_KEYS,
    useThemeColors,
} from '@/hooks/useThemeColors'

function setScheme(scheme: string): void {
    document.documentElement.setAttribute('data-theme', scheme)
}

describe('useThemeColors', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
        document.documentElement.removeAttribute('style')
    })

    afterEach(() => {
        disposeThemeColors()
        vi.restoreAllMocks()
    })

    it('exposes a curated set of key colors including background and accent', () => {
        const ids = THEME_COLOR_KEYS.map((key) => key.id)
        expect(THEME_COLOR_KEYS.length).toBeGreaterThanOrEqual(6)
        expect(ids).toContain('background')
        expect(ids).toContain('accent')
    })

    it('writes the mapped CSS variables when a key color is customized', () => {
        setScheme('oled')
        const { result } = renderHook(() => useThemeColors())

        act(() => result.current.setColor('background', '#123456'))

        expect(document.documentElement.style.getPropertyValue('--app-bg').trim()).toBe('#123456')
        expect(localStorage.getItem('hapi-theme-colors')).toContain('123456')
    })

    it('ignores invalid hex values', () => {
        setScheme('oled')
        const { result } = renderHook(() => useThemeColors())

        act(() => result.current.setColor('background', 'not-a-color'))

        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')
        expect(localStorage.getItem('hapi-theme-colors')).toBeNull()
    })

    it('scopes custom colors per appearance', () => {
        setScheme('dark')
        const { result } = renderHook(() => useThemeColors())

        act(() => result.current.setColor('background', '#111111'))
        expect(document.documentElement.style.getPropertyValue('--app-bg').trim()).toBe('#111111')

        // A dark-only override must not leak into the light appearance.
        act(() => setScheme('light'))
        applyThemeColors()
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')

        // Switching back restores it.
        act(() => setScheme('dark'))
        applyThemeColors()
        expect(document.documentElement.style.getPropertyValue('--app-bg').trim()).toBe('#111111')
    })

    it('resets a key color back to the theme default', () => {
        setScheme('oled')
        const { result } = renderHook(() => useThemeColors())

        act(() => result.current.setColor('background', '#123456'))
        act(() => result.current.resetColor('background'))

        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')
        expect(localStorage.getItem('hapi-theme-colors')).toBeNull()
    })

    it('reapplies stored colors for the active appearance during initialization', () => {
        localStorage.setItem('hapi-theme-colors', JSON.stringify({ oled: { background: '#0b0b0b' } }))
        setScheme('oled')

        initializeThemeColors()

        expect(document.documentElement.style.getPropertyValue('--app-bg').trim()).toBe('#0b0b0b')
    })
})
