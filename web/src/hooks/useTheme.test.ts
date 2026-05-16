import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { getThemeColor, initializeTheme, useAppearance } from '@/hooks/useTheme'

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
})
