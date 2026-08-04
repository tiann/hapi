import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_PIN_IN_PROGRESS_SESSIONS = false

function getPinInProgressSessionsStorageKey(): string {
    return 'hapi-pin-in-progress-sessions'
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

function parsePinInProgressSessions(raw: string | null): boolean {
    if (raw === 'true') {
        return true
    }
    return DEFAULT_PIN_IN_PROGRESS_SESSIONS
}

export function getInitialPinInProgressSessions(): boolean {
    return parsePinInProgressSessions(safeGetItem(getPinInProgressSessionsStorageKey()))
}

export function usePinInProgressSessions(): {
    pinInProgressSessions: boolean
    setPinInProgressSessions: (value: boolean) => void
} {
    const [pinInProgressSessions, setPinInProgressSessionsState] = useState<boolean>(getInitialPinInProgressSessions)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getPinInProgressSessionsStorageKey()) {
                return
            }
            setPinInProgressSessionsState(parsePinInProgressSessions(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setPinInProgressSessions = useCallback((value: boolean) => {
        setPinInProgressSessionsState(value)

        if (value === DEFAULT_PIN_IN_PROGRESS_SESSIONS) {
            safeRemoveItem(getPinInProgressSessionsStorageKey())
        } else {
            safeSetItem(getPinInProgressSessionsStorageKey(), String(value))
        }
    }, [])

    return { pinInProgressSessions, setPinInProgressSessions }
}
