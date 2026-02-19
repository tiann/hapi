import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { getTelegramWebApp } from './useTelegram'

export type ThemePreference = 'system' | 'light' | 'dark' | 'catpuccin' | 'gaius' | 'gaius-light' | 'gaius-dark'
type ResolvedTheme = 'light' | 'dark' | 'catpuccin' | 'gaius-light' | 'gaius-dark'

const STORAGE_KEY = 'hapi-theme'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

const useIsomorphicLayoutEffect = isBrowser() ? useLayoutEffect : useEffect

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

function parseThemePreference(raw: string | null): ThemePreference {
    if (raw === 'light' || raw === 'dark' || raw === 'catpuccin' || raw === 'gaius' || raw === 'gaius-light' || raw === 'gaius-dark') return raw
    return 'system'
}

function getSystemColorScheme(): 'light' | 'dark' {
    const tg = getTelegramWebApp()
    if (tg?.colorScheme) {
        return tg.colorScheme === 'dark' ? 'dark' : 'light'
    }
    if (isBrowser() && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return 'light'
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
    if (pref === 'system') return getSystemColorScheme()
    if (pref === 'gaius') return getSystemColorScheme() === 'dark' ? 'gaius-dark' : 'gaius-light'
    return pref
}

function applyTheme(theme: ResolvedTheme): void {
    if (!isBrowser()) return
    document.documentElement.setAttribute('data-theme', theme)
}

function isIOS(): boolean {
    if (typeof navigator === 'undefined') return false
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

function applyPlatform(): void {
    if (isIOS()) {
        document.documentElement.classList.add('ios')
    }
}

function getInitialPreference(): ThemePreference {
    return parseThemePreference(safeGetItem(STORAGE_KEY))
}

function isSystemLinkedPreference(pref: ThemePreference): boolean {
    return pref === 'system' || pref === 'gaius'
}

let themePreferenceState: ThemePreference = getInitialPreference()
const themeSubscribers = new Set<() => void>()
let storageSyncInitialized = false
let mediaQueryListenerInitialized = false
let telegramThemeListenerInitialized = false
let mediaQueryList: MediaQueryList | null = null

function notifyThemeSubscribers(): void {
    themeSubscribers.forEach((subscriber) => subscriber())
}

function applyThemePreference(pref: ThemePreference): void {
    themePreferenceState = pref
    applyTheme(resolveTheme(pref))
}

function persistThemePreference(pref: ThemePreference): void {
    if (pref === 'system') {
        safeRemoveItem(STORAGE_KEY)
        return
    }
    safeSetItem(STORAGE_KEY, pref)
}

function setThemePreferenceState(pref: ThemePreference, options?: { persist?: boolean }): void {
    const previous = themePreferenceState
    applyThemePreference(pref)
    if (options?.persist !== false) {
        persistThemePreference(pref)
    }
    if (previous !== pref) {
        notifyThemeSubscribers()
    }
}

function onSystemThemeChanged(): void {
    if (!isSystemLinkedPreference(themePreferenceState)) {
        return
    }
    applyTheme(resolveTheme(themePreferenceState))
    notifyThemeSubscribers()
}

function ensureThemeListeners(): void {
    if (!isBrowser()) return

    if (!storageSyncInitialized) {
        const onStorage = (event: StorageEvent) => {
            if (event.key !== STORAGE_KEY) return
            const next = parseThemePreference(event.newValue)
            setThemePreferenceState(next, { persist: false })
        }
        window.addEventListener('storage', onStorage)
        storageSyncInitialized = true
    }

    if (window.matchMedia) {
        const nextMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
        if (!mediaQueryListenerInitialized || mediaQueryList !== nextMediaQuery) {
            mediaQueryList?.removeEventListener('change', onSystemThemeChanged)
            nextMediaQuery.addEventListener('change', onSystemThemeChanged)
            mediaQueryList = nextMediaQuery
            mediaQueryListenerInitialized = true
        }
    }

    if (!telegramThemeListenerInitialized) {
        const tg = getTelegramWebApp()
        if (tg?.onEvent) {
            tg.onEvent('themeChanged', onSystemThemeChanged)
            telegramThemeListenerInitialized = true
        }
    }
}

export function initializeTheme(): void {
    themePreferenceState = getInitialPreference()
    applyPlatform()
    applyTheme(resolveTheme(themePreferenceState))
    ensureThemeListeners()
}

export function getThemeOptions(): ReadonlyArray<{ value: ThemePreference; label: string }> {
    return [
        { value: 'system', label: 'system' },
        { value: 'light', label: 'light' },
        { value: 'dark', label: 'dark' },
        { value: 'catpuccin', label: 'catpuccin' },
        { value: 'gaius', label: 'gaius' },
        { value: 'gaius-light', label: 'gaius-light' },
        { value: 'gaius-dark', label: 'gaius-dark' },
    ]
}

export function useTheme(): {
    themePreference: ThemePreference
    setThemePreference: (pref: ThemePreference) => void
    isDark: boolean
} {
    const themePreference = useSyncExternalStore(
        (subscriber) => {
            ensureThemeListeners()
            themeSubscribers.add(subscriber)
            return () => {
                themeSubscribers.delete(subscriber)
            }
        },
        () => themePreferenceState,
        () => themePreferenceState
    )
    const resolved = resolveTheme(themePreference)

    useIsomorphicLayoutEffect(() => {
        applyTheme(resolved)
    }, [resolved])

    useEffect(() => {
        ensureThemeListeners()
    }, [])

    const setThemePreference = useCallback((pref: ThemePreference) => {
        setThemePreferenceState(pref)
    }, [])

    return {
        themePreference,
        setThemePreference,
        isDark: resolved !== 'light' && resolved !== 'gaius-light',
    }
}
