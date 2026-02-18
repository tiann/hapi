import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
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

export function initializeTheme(): void {
    applyPlatform()
    applyTheme(resolveTheme(getInitialPreference()))
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
    const [themePreference, setThemePreferenceState] = useState<ThemePreference>(getInitialPreference)

    const resolved = resolveTheme(themePreference)

    useIsomorphicLayoutEffect(() => {
        applyTheme(resolved)
    }, [resolved])

    // Listen for system color scheme changes (matters when pref is 'system' or 'gaius')
    useEffect(() => {
        if (themePreference !== 'system' && themePreference !== 'gaius') return undefined

        const tg = getTelegramWebApp()
        if (tg?.onEvent) {
            const handler = () => applyTheme(resolveTheme(themePreference))
            tg.onEvent('themeChanged', handler)
            return () => tg.offEvent?.('themeChanged', handler)
        }

        if (isBrowser() && window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)')
            const handler = () => applyTheme(resolveTheme(themePreference))
            mq.addEventListener('change', handler)
            return () => mq.removeEventListener('change', handler)
        }

        return undefined
    }, [themePreference])

    // Cross-tab sync
    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== STORAGE_KEY) return
            const next = parseThemePreference(event.newValue)
            setThemePreferenceState(next)
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setThemePreference = useCallback((pref: ThemePreference) => {
        setThemePreferenceState(pref)
        if (pref === 'system') {
            safeRemoveItem(STORAGE_KEY)
        } else {
            safeSetItem(STORAGE_KEY, pref)
        }
    }, [])

    return {
        themePreference,
        setThemePreference,
        isDark: resolved !== 'light' && resolved !== 'gaius-light',
    }
}
