import { useCallback, useEffect, useState } from 'react'

export type SessionProjectSortMode = 'recent' | 'count'

export const DEFAULT_SESSION_PROJECT_SORT_MODE: SessionProjectSortMode = 'recent'

const SESSION_PROJECT_SORT_MODE_CHANGED_EVENT = 'hapi-session-project-sort-mode-changed'

export function getSessionProjectSortModeOptions(): ReadonlyArray<{ value: SessionProjectSortMode; labelKey: string }> {
    return [
        { value: 'recent', labelKey: 'settings.display.projectSort.recent' },
        { value: 'count', labelKey: 'settings.display.projectSort.count' },
    ]
}

function getStorageKey(): string {
    return 'hapi-session-project-sort-mode'
}

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
        // Ignore storage errors.
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors.
    }
}

function parseSessionProjectSortMode(raw: string | null): SessionProjectSortMode {
    if (raw === 'recent' || raw === 'count') return raw
    // Migrate the previous PR-local setting to its replacement mode.
    if (raw === 'stable') return 'count'
    return DEFAULT_SESSION_PROJECT_SORT_MODE
}

export function getInitialSessionProjectSortMode(): SessionProjectSortMode {
    return parseSessionProjectSortMode(safeGetItem(getStorageKey()))
}

export function useSessionProjectSortMode(): {
    sessionProjectSortMode: SessionProjectSortMode
    setSessionProjectSortMode: (mode: SessionProjectSortMode) => void
} {
    const [sessionProjectSortMode, setSessionProjectSortModeState] = useState<SessionProjectSortMode>(getInitialSessionProjectSortMode)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key === getStorageKey()) {
                setSessionProjectSortModeState(parseSessionProjectSortMode(event.newValue))
            }
        }
        const onLocalChange = (event: Event) => {
            if (!(event instanceof CustomEvent)) return
            if (event.detail === 'recent' || event.detail === 'count') {
                setSessionProjectSortModeState(event.detail)
            }
        }

        window.addEventListener('storage', onStorage)
        window.addEventListener(SESSION_PROJECT_SORT_MODE_CHANGED_EVENT, onLocalChange)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(SESSION_PROJECT_SORT_MODE_CHANGED_EVENT, onLocalChange)
        }
    }, [])

    const setSessionProjectSortMode = useCallback((mode: SessionProjectSortMode) => {
        setSessionProjectSortModeState(mode)
        if (mode === DEFAULT_SESSION_PROJECT_SORT_MODE) {
            safeRemoveItem(getStorageKey())
        } else {
            safeSetItem(getStorageKey(), mode)
        }
        if (isBrowser()) {
            window.dispatchEvent(new CustomEvent(SESSION_PROJECT_SORT_MODE_CHANGED_EVENT, { detail: mode }))
        }
    }, [])

    return { sessionProjectSortMode, setSessionProjectSortMode }
}
