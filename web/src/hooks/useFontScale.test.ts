import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFontScaleOptions, initializeFontScale, useFontScale } from './useFontScale'

describe('useFontScale', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    afterEach(() => {
        document.documentElement.style.removeProperty('--app-font-scale')
    })

    it('offers 130% alongside the existing sizes', () => {
        expect(getFontScaleOptions()).toEqual([
            { value: 0.8, label: '80%' },
            { value: 0.9, label: '90%' },
            { value: 1, label: '100%' },
            { value: 1.1, label: '110%' },
            { value: 1.2, label: '120%' },
            { value: 1.3, label: '130%' },
        ])
    })

    it.each([1.3] as const)('applies scale %s and restores it on startup and remount', (scale) => {
        const { result, unmount } = renderHook(() => useFontScale())
        act(() => result.current.setFontScale(scale))

        expect(document.documentElement.style.getPropertyValue('--app-font-scale')).toBe(String(scale))
        expect(window.localStorage.getItem('hapi-font-scale')).toBe(String(scale))
        unmount()

        document.documentElement.style.removeProperty('--app-font-scale')
        initializeFontScale()
        expect(document.documentElement.style.getPropertyValue('--app-font-scale')).toBe(String(scale))

        const restored = renderHook(() => useFontScale())
        expect(restored.result.current.fontScale).toBe(scale)
        restored.unmount()
    })

    it('falls back to 100% for an unsupported stored scale', () => {
        window.localStorage.setItem('hapi-font-scale', '1.4')
        initializeFontScale()
        expect(document.documentElement.style.getPropertyValue('--app-font-scale')).toBe('1')
    })
})
