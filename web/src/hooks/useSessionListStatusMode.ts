import { useCallback, useEffect, useState } from 'react'

export type SessionListStatusMode = 'standard' | 'detailed'

export const DEFAULT_SESSION_LIST_STATUS_MODE: SessionListStatusMode = 'standard'

export function getSessionListStatusModeOptions(): ReadonlyArray<{ value: SessionListStatusMode; labelKey: string }> {
    return [
        { value: 'standard', labelKey: 'settings.display.sessionListStatus.standard' },
        { value: 'detailed', labelKey: 'settings.display.sessionListStatus.detailed' },
    ]
}

function getSessionListStatusModeStorageKey(): string {
    return 'hapi-session-list-status-mode'
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

function parseSessionListStatusMode(raw: string | null): SessionListStatusMode {
    if (raw === 'standard' || raw === 'detailed') {
        return raw
    }
    return DEFAULT_SESSION_LIST_STATUS_MODE
}

export function getInitialSessionListStatusMode(): SessionListStatusMode {
    return parseSessionListStatusMode(safeGetItem(getSessionListStatusModeStorageKey()))
}

export function useSessionListStatusMode(): {
    sessionListStatusMode: SessionListStatusMode
    setSessionListStatusMode: (mode: SessionListStatusMode) => void
} {
    const [sessionListStatusMode, setSessionListStatusModeState] = useState<SessionListStatusMode>(getInitialSessionListStatusMode)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getSessionListStatusModeStorageKey()) {
                return
            }
            setSessionListStatusModeState(parseSessionListStatusMode(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setSessionListStatusMode = useCallback((mode: SessionListStatusMode) => {
        setSessionListStatusModeState(mode)

        if (mode === DEFAULT_SESSION_LIST_STATUS_MODE) {
            safeRemoveItem(getSessionListStatusModeStorageKey())
        } else {
            safeSetItem(getSessionListStatusModeStorageKey(), mode)
        }
    }, [])

    return { sessionListStatusMode, setSessionListStatusMode }
}
