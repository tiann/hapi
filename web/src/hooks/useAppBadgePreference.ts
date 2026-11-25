import { useCallback, useEffect, useState } from 'react'

const APP_BADGE_ENABLED_STORAGE_KEY = 'hapi-app-badge-enabled'
export const DEFAULT_APP_BADGE_ENABLED = false

const sameTabListeners = new Set<(enabled: boolean) => void>()

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

function parseAppBadgeEnabled(raw: string | null): boolean {
    if (raw === 'true') {
        return true
    }
    return DEFAULT_APP_BADGE_ENABLED
}

export function getInitialAppBadgeEnabled(): boolean {
    return parseAppBadgeEnabled(safeGetItem(APP_BADGE_ENABLED_STORAGE_KEY))
}

export function useAppBadgePreference(): {
    appBadgeEnabled: boolean
    setAppBadgeEnabled: (enabled: boolean) => void
} {
    const [appBadgeEnabled, setAppBadgeEnabledState] = useState<boolean>(getInitialAppBadgeEnabled)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== APP_BADGE_ENABLED_STORAGE_KEY) {
                return
            }
            setAppBadgeEnabledState(parseAppBadgeEnabled(event.newValue))
        }

        sameTabListeners.add(setAppBadgeEnabledState)
        window.addEventListener('storage', onStorage)
        return () => {
            sameTabListeners.delete(setAppBadgeEnabledState)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    const setAppBadgeEnabled = useCallback((enabled: boolean) => {
        for (const listener of sameTabListeners) {
            listener(enabled)
        }

        if (enabled === DEFAULT_APP_BADGE_ENABLED) {
            safeRemoveItem(APP_BADGE_ENABLED_STORAGE_KEY)
        } else {
            safeSetItem(APP_BADGE_ENABLED_STORAGE_KEY, String(enabled))
        }
    }, [])

    return { appBadgeEnabled, setAppBadgeEnabled }
}
