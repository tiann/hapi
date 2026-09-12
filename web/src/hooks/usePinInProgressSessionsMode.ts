import { useCallback, useEffect, useState } from 'react'

export type PinInProgressSessionsMode = 'detailed' | 'combined'

export const DEFAULT_PIN_IN_PROGRESS_SESSIONS_MODE: PinInProgressSessionsMode = 'detailed'

const PIN_IN_PROGRESS_SESSIONS_MODE_CHANGED_EVENT = 'hapi-pin-in-progress-sessions-mode-changed'

export function getPinInProgressSessionsModeOptions(): ReadonlyArray<{ value: PinInProgressSessionsMode; labelKey: string }> {
    return [
        { value: 'combined', labelKey: 'settings.display.pinInProgressSessions.mode.combined' },
        { value: 'detailed', labelKey: 'settings.display.pinInProgressSessions.mode.detailed' },
    ]
}

function getPinInProgressSessionsModeStorageKey(): string {
    return 'hapi-pin-in-progress-sessions-mode'
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

function parsePinInProgressSessionsMode(raw: string | null): PinInProgressSessionsMode {
    if (raw === 'detailed' || raw === 'combined') {
        return raw
    }
    return DEFAULT_PIN_IN_PROGRESS_SESSIONS_MODE
}

export function getInitialPinInProgressSessionsMode(): PinInProgressSessionsMode {
    return parsePinInProgressSessionsMode(safeGetItem(getPinInProgressSessionsModeStorageKey()))
}

export function usePinInProgressSessionsMode(): {
    pinInProgressSessionsMode: PinInProgressSessionsMode
    setPinInProgressSessionsMode: (mode: PinInProgressSessionsMode) => void
} {
    const [pinInProgressSessionsMode, setPinInProgressSessionsModeState] = useState<PinInProgressSessionsMode>(getInitialPinInProgressSessionsMode)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getPinInProgressSessionsModeStorageKey()) {
                return
            }
            setPinInProgressSessionsModeState(parsePinInProgressSessionsMode(event.newValue))
        }

        const onLocalChange = (event: Event) => {
            if (!(event instanceof CustomEvent)) {
                return
            }
            const next = event.detail
            if (next === 'detailed' || next === 'combined') {
                setPinInProgressSessionsModeState(next)
            }
        }

        window.addEventListener('storage', onStorage)
        window.addEventListener(PIN_IN_PROGRESS_SESSIONS_MODE_CHANGED_EVENT, onLocalChange)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(PIN_IN_PROGRESS_SESSIONS_MODE_CHANGED_EVENT, onLocalChange)
        }
    }, [])

    const setPinInProgressSessionsMode = useCallback((mode: PinInProgressSessionsMode) => {
        setPinInProgressSessionsModeState(mode)

        if (mode === DEFAULT_PIN_IN_PROGRESS_SESSIONS_MODE) {
            safeRemoveItem(getPinInProgressSessionsModeStorageKey())
        } else {
            safeSetItem(getPinInProgressSessionsModeStorageKey(), mode)
        }

        if (isBrowser()) {
            window.dispatchEvent(new CustomEvent(PIN_IN_PROGRESS_SESSIONS_MODE_CHANGED_EVENT, { detail: mode }))
        }
    }, [])

    return { pinInProgressSessionsMode, setPinInProgressSessionsMode }
}
