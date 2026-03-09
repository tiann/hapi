import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getTelegramWebApp } from './useTelegram'

type ColorScheme = 'light' | 'dark'

export type AppearancePreference = 'system' | 'dark' | 'light'

const APPEARANCE_KEY = 'hapi-appearance'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

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

function parseAppearance(raw: string | null): AppearancePreference {
    if (raw === 'dark' || raw === 'light') return raw
    return 'system'
}

function getStoredAppearance(): AppearancePreference {
    return parseAppearance(safeGetItem(APPEARANCE_KEY))
}

export function getAppearanceOptions(): ReadonlyArray<{ value: AppearancePreference; labelKey: string }> {
    return [
        { value: 'system', labelKey: 'settings.display.appearance.system' },
        { value: 'dark', labelKey: 'settings.display.appearance.dark' },
        { value: 'light', labelKey: 'settings.display.appearance.light' },
    ]
}

function getColorScheme(): ColorScheme {
    const pref = getStoredAppearance()
    if (pref === 'dark' || pref === 'light') return pref

    // 'system': use Telegram → system preference → light
    const tg = getTelegramWebApp()
    if (tg?.colorScheme) {
        return tg.colorScheme === 'dark' ? 'dark' : 'light'
    }

    // Fallback to system preference for browser environment
    if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }

    return 'light'
}

function isIOS(): boolean {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

function applyTheme(scheme: ColorScheme): void {
    document.documentElement.setAttribute('data-theme', scheme)
}

function applyPlatform(): void {
    if (isIOS()) {
        document.documentElement.classList.add('ios')
    }
}

// External store for theme state
let currentScheme: ColorScheme = getColorScheme()
const listeners = new Set<() => void>()

// Apply theme immediately at module load (before React renders)
applyTheme(currentScheme)

function subscribe(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

function getSnapshot(): ColorScheme {
    return currentScheme
}

function updateScheme(): void {
    const newScheme = getColorScheme()
    if (newScheme !== currentScheme) {
        currentScheme = newScheme
        applyTheme(newScheme)
        listeners.forEach((cb) => cb())
    }
}

// Track if theme listeners have been set up
let listenersInitialized = false

export function useTheme(): { colorScheme: ColorScheme; isDark: boolean } {
    const colorScheme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

    return {
        colorScheme,
        isDark: colorScheme === 'dark',
    }
}

export function useAppearance(): { appearance: AppearancePreference; setAppearance: (pref: AppearancePreference) => void } {
    const [appearance, setAppearanceState] = useState<AppearancePreference>(getStoredAppearance)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== APPEARANCE_KEY) return
            setAppearanceState(parseAppearance(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setAppearance = useCallback((pref: AppearancePreference) => {
        setAppearanceState(pref)

        if (pref === 'system') {
            safeRemoveItem(APPEARANCE_KEY)
        } else {
            safeSetItem(APPEARANCE_KEY, pref)
        }

        updateScheme()
    }, [])

    return { appearance, setAppearance }
}

// Call this once at app startup to ensure theme is applied and listeners attached
export function initializeTheme(): void {
    currentScheme = getColorScheme()
    applyTheme(currentScheme)

    // Set up listeners only once (after SDK may have loaded)
    if (!listenersInitialized) {
        listenersInitialized = true
        const tg = getTelegramWebApp()
        if (tg?.onEvent) {
            // Telegram theme changes
            tg.onEvent('themeChanged', updateScheme)
        } else if (typeof window !== 'undefined' && window.matchMedia) {
            // Browser system preference changes
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
            mediaQuery.addEventListener('change', updateScheme)
        }

        // Cross-tab appearance sync: update theme when another tab changes localStorage
        if (typeof window !== 'undefined') {
            window.addEventListener('storage', (event: StorageEvent) => {
                if (event.key === APPEARANCE_KEY) updateScheme()
            })
        }
    }
}
