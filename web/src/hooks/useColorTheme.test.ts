import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    applyColorTheme,
    getColorThemeStorageKey,
    getStoredColorTheme,
    parseColorTheme,
    useColorTheme,
} from './useColorTheme'

const THEME_VARS = ['--app-bg', '--app-fg', '--app-link', '--app-button', '--app-secondary-bg']

describe('useColorTheme', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-color-theme')
        document.documentElement.setAttribute('data-theme', 'light')
        for (const name of THEME_VARS) document.documentElement.style.removeProperty(name)
    })

    it('parses invalid or missing stored values as default', () => {
        expect(parseColorTheme(null)).toBe('default')
        expect(parseColorTheme('unknown')).toBe('default')
        expect(parseColorTheme('notion')).toBe('notion')
    })

    it('reads the stored color theme preference', () => {
        localStorage.setItem(getColorThemeStorageKey(), 'rose-pine')
        expect(getStoredColorTheme()).toBe('rose-pine')
    })

    it('applies a preset palette to the document css variables', () => {
        applyColorTheme('one', 'light')
        expect(document.documentElement).toHaveAttribute('data-color-theme', 'one')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#fbfbff')
        expect(document.documentElement.style.getPropertyValue('--app-link')).toBe('#526fff')
    })

    it('removes palette css variables when reset to default', () => {
        applyColorTheme('one', 'dark')
        applyColorTheme('default', 'dark')

        expect(document.documentElement).toHaveAttribute('data-color-theme', 'default')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')
        expect(document.documentElement.style.getPropertyValue('--app-link')).toBe('')
    })

    it('persists non-default selections and removes the key for default', () => {
        const { result } = renderHook(() => useColorTheme())

        act(() => result.current.setColorTheme('night-owl'))
        expect(localStorage.getItem(getColorThemeStorageKey())).toBe('night-owl')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#fbfdff')

        act(() => result.current.setColorTheme('default'))
        expect(localStorage.getItem(getColorThemeStorageKey())).toBeNull()
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')
    })

    it('uses the current dark scheme when applying from the hook', () => {
        document.documentElement.setAttribute('data-theme', 'dark')
        const { result } = renderHook(() => useColorTheme())

        act(() => result.current.setColorTheme('notion'))
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#191919')
        expect(document.documentElement.style.getPropertyValue('--app-fg')).toBe('#d9d9d8')
    })
})
