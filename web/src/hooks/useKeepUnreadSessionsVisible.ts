import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_KEEP_UNREAD_SESSIONS_VISIBLE = true

function getKeepUnreadSessionsVisibleStorageKey(): string {
    return 'hapi-keep-unread-sessions-visible'
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

function parseKeepUnreadSessionsVisible(raw: string | null): boolean {
    if (raw === 'false') {
        return false
    }
    return DEFAULT_KEEP_UNREAD_SESSIONS_VISIBLE
}

export function getInitialKeepUnreadSessionsVisible(): boolean {
    return parseKeepUnreadSessionsVisible(safeGetItem(getKeepUnreadSessionsVisibleStorageKey()))
}

export function useKeepUnreadSessionsVisible(): {
    keepUnreadSessionsVisible: boolean
    setKeepUnreadSessionsVisible: (value: boolean) => void
} {
    const [keepUnreadSessionsVisible, setKeepUnreadSessionsVisibleState] = useState<boolean>(getInitialKeepUnreadSessionsVisible)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getKeepUnreadSessionsVisibleStorageKey()) {
                return
            }
            setKeepUnreadSessionsVisibleState(parseKeepUnreadSessionsVisible(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setKeepUnreadSessionsVisible = useCallback((value: boolean) => {
        setKeepUnreadSessionsVisibleState(value)

        if (value === DEFAULT_KEEP_UNREAD_SESSIONS_VISIBLE) {
            safeRemoveItem(getKeepUnreadSessionsVisibleStorageKey())
        } else {
            safeSetItem(getKeepUnreadSessionsVisibleStorageKey(), String(value))
        }
    }, [])

    return { keepUnreadSessionsVisible, setKeepUnreadSessionsVisible }
}
