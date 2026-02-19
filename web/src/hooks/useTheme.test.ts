import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { initializeTheme, useTheme } from './useTheme'

vi.mock('./useTelegram', () => ({
    getTelegramWebApp: vi.fn(() => null)
}))

function createMatchMediaStub(initialDark = false) {
    const listeners = new Set<EventListenerOrEventListenerObject>()
    const mediaQuery = {
        media: '(prefers-color-scheme: dark)',
        matches: initialDark,
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
            listeners.add(listener)
        },
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
            listeners.delete(listener)
        },
        dispatchEvent: () => true,
        addListener: () => {},
        removeListener: () => {},
    } as MediaQueryList

    const setDark = (next: boolean) => {
        ;(mediaQuery as { matches: boolean }).matches = next
        const event = { matches: next } as MediaQueryListEvent
        listeners.forEach((listener) => {
            if (typeof listener === 'function') {
                listener.call(mediaQuery, event)
                return
            }
            listener.handleEvent(event)
        })
    }

    return { mediaQuery, setDark }
}

describe('useTheme', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
        const { mediaQuery } = createMatchMediaStub(false)
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn(() => mediaQuery)
        })
    })

    it('initializeTheme applies stored theme preference', () => {
        const { mediaQuery } = createMatchMediaStub(false)
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn(() => mediaQuery)
        })
        localStorage.setItem('hapi-theme', 'catpuccin')

        initializeTheme()

        expect(document.documentElement.getAttribute('data-theme')).toBe('catpuccin')
    })

    it('initializeTheme resolves gaius against system scheme', () => {
        const { mediaQuery } = createMatchMediaStub(true)
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn(() => mediaQuery)
        })
        localStorage.setItem('hapi-theme', 'gaius')

        initializeTheme()

        expect(document.documentElement.getAttribute('data-theme')).toBe('gaius-dark')
    })

    it('initializeTheme keeps system theme reactive without mounted hook', () => {
        const { mediaQuery, setDark } = createMatchMediaStub(false)
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn(() => mediaQuery)
        })
        localStorage.removeItem('hapi-theme')

        initializeTheme()
        expect(document.documentElement.getAttribute('data-theme')).toBe('light')

        act(() => setDark(true))
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })

    it('persists and clears theme preference from hook setter', () => {
        const { mediaQuery } = createMatchMediaStub(false)
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn(() => mediaQuery)
        })

        const { result } = renderHook(() => useTheme())
        act(() => result.current.setThemePreference('dark'))
        expect(localStorage.getItem('hapi-theme')).toBe('dark')
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

        act(() => result.current.setThemePreference('system'))
        expect(localStorage.getItem('hapi-theme')).toBeNull()
    })

    it('updates resolved gaius theme when system preference changes', () => {
        const { mediaQuery, setDark } = createMatchMediaStub(false)
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn(() => mediaQuery)
        })
        localStorage.setItem('hapi-theme', 'gaius')

        initializeTheme()
        renderHook(() => useTheme())
        expect(document.documentElement.getAttribute('data-theme')).toBe('gaius-light')

        act(() => setDark(true))
        expect(document.documentElement.getAttribute('data-theme')).toBe('gaius-dark')
    })

    it('shares theme preference state across hook consumers', () => {
        const { mediaQuery } = createMatchMediaStub(false)
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn(() => mediaQuery)
        })
        initializeTheme()

        const first = renderHook(() => useTheme())
        const second = renderHook(() => useTheme())

        act(() => first.result.current.setThemePreference('dark'))
        expect(second.result.current.themePreference).toBe('dark')
    })
})
