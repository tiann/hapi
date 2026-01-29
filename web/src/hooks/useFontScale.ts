import { useCallback, useEffect, useState } from 'react'

export type FontScale = 0.8 | 0.9 | 1 | 1.1 | 1.2

export function getFontScaleOptions(): ReadonlyArray<{ value: FontScale; label: string }> {
    return [
        { value: 0.8, label: '80%' },
        { value: 0.9, label: '90%' },
        { value: 1, label: '100%' },
        { value: 1.1, label: '110%' },
        { value: 1.2, label: '120%' },
    ]
}

function getFontScaleStorageKey(): string {
    return 'hapi-font-scale'
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) {
        return null
    }
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) {
        return
    }
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) {
        return
    }
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

function parseFontScale(raw: string | null): FontScale {
    const value = Number(raw)
    if (value === 0.8 || value === 0.9 || value === 1 || value === 1.1 || value === 1.2) {
        return value
    }
    return 1
}

function applyFontScale(scale: FontScale): void {
    if (!isBrowser()) {
        return
    }
    document.documentElement.style.setProperty('--app-font-scale', String(scale))
}

function getInitialFontScale(): FontScale {
    return parseFontScale(safeGetItem(getFontScaleStorageKey()))
}

export function initializeFontScale(): void {
    applyFontScale(getInitialFontScale())
}

export function useFontScale(): { fontScale: FontScale; setFontScale: (scale: FontScale) => void } {
    const [fontScale, setFontScaleState] = useState<FontScale>(getInitialFontScale)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getFontScaleStorageKey()) {
                return
            }
            const nextScale = parseFontScale(event.newValue)
            setFontScaleState(nextScale)
            applyFontScale(nextScale)
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setFontScale = useCallback((scale: FontScale) => {
        setFontScaleState(scale)
        applyFontScale(scale)

        if (scale === 1) {
            safeRemoveItem(getFontScaleStorageKey())
        } else {
            safeSetItem(getFontScaleStorageKey(), String(scale))
        }
    }, [])

    return { fontScale, setFontScale }
}
