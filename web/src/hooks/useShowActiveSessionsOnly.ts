import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_SHOW_ACTIVE_SESSIONS_ONLY = false

function getShowActiveSessionsOnlyStorageKey(): string {
    return 'hapi-show-active-sessions-only'
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

function parseShowActiveSessionsOnly(raw: string | null): boolean {
    if (raw === 'true') {
        return true
    }
    return DEFAULT_SHOW_ACTIVE_SESSIONS_ONLY
}

export function getInitialShowActiveSessionsOnly(): boolean {
    return parseShowActiveSessionsOnly(safeGetItem(getShowActiveSessionsOnlyStorageKey()))
}

export function useShowActiveSessionsOnly(): {
    showActiveSessionsOnly: boolean
    setShowActiveSessionsOnly: (value: boolean) => void
} {
    const [showActiveSessionsOnly, setShowActiveSessionsOnlyState] = useState<boolean>(getInitialShowActiveSessionsOnly)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getShowActiveSessionsOnlyStorageKey()) {
                return
            }
            setShowActiveSessionsOnlyState(parseShowActiveSessionsOnly(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setShowActiveSessionsOnly = useCallback((value: boolean) => {
        setShowActiveSessionsOnlyState(value)

        if (value === DEFAULT_SHOW_ACTIVE_SESSIONS_ONLY) {
            safeRemoveItem(getShowActiveSessionsOnlyStorageKey())
        } else {
            safeSetItem(getShowActiveSessionsOnlyStorageKey(), String(value))
        }
    }, [])

    return { showActiveSessionsOnly, setShowActiveSessionsOnly }
}
