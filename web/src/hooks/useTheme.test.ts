import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAppearanceOptions, getThemeColor, initializeTheme, useAppearance } from '@/hooks/useTheme'

describe('useTheme', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
        document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove())
    })

    it('applies the stored dark appearance to the document and browser theme color', () => {
        localStorage.setItem('hapi-appearance', 'dark')

        initializeTheme()

        expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
        expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(getThemeColor('dark'))
    })

    it('creates a browser theme color meta tag when the page does not provide one', () => {
        initializeTheme()

        const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        expect(meta?.content).toBe(getThemeColor('light'))
        expect(meta?.hasAttribute('media')).toBe(false)
    })

    it('updates the browser theme color when appearance changes', () => {
        const { result } = renderHook(() => useAppearance())

        act(() => {
            result.current.setAppearance('dark')
        })

        expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
        expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(getThemeColor('dark'))

        act(() => {
            result.current.setAppearance('light')
        })

        expect(document.documentElement).toHaveAttribute('data-theme', 'light')
        expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(getThemeColor('light'))
    })

    it('exposes OLED Black as a selectable appearance option', () => {
        expect(getAppearanceOptions().some((opt) => opt.value === 'oled')).toBe(true)
    })

    it('applies the OLED appearance with a pure-black browser theme color', () => {
        localStorage.setItem('hapi-appearance', 'oled')

        initializeTheme()

        expect(document.documentElement).toHaveAttribute('data-theme', 'oled')
        expect(getThemeColor('oled')).toBe('#000000')
        expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#000000')
    })

    it('does not auto-select OLED for the system appearance', () => {
        // No stored appearance => system; system must resolve to light/dark, never OLED.
        initializeTheme()

        const theme = document.documentElement.getAttribute('data-theme')
        expect(theme === 'light' || theme === 'dark').toBe(true)
        expect(theme).not.toBe('oled')
    })
})
