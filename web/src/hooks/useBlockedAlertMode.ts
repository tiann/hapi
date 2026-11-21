import { useCallback, useEffect, useState } from 'react'

/**
 * How loudly the session list announces a *newly* blocked agent (#1717).
 *
 * Escalation, not decoration: the always-visible counter is the baseline and
 * is never suppressed. These modes only govern the transition alert, because a
 * permanent pulse at fleet scale becomes wallpaper within a day.
 *
 *  - `count`  — number only, no pulse, no sound
 *  - `pulse`  — the counter pulses briefly when a new blocker appears (default)
 *  - `sound`  — pulse plus a short error tone
 */
export type BlockedAlertMode = 'count' | 'pulse' | 'sound'

export const DEFAULT_BLOCKED_ALERT_MODE: BlockedAlertMode = 'pulse'

/** How long the counter pulses after a new blocker arrives. */
export const BLOCKED_ALERT_PULSE_MS = 8000

export function getBlockedAlertModeOptions(): ReadonlyArray<{ value: BlockedAlertMode; labelKey: string }> {
    return [
        { value: 'count', labelKey: 'settings.display.blockedAlert.count' },
        { value: 'pulse', labelKey: 'settings.display.blockedAlert.pulse' },
        { value: 'sound', labelKey: 'settings.display.blockedAlert.sound' },
    ]
}

function storageKey(): string {
    return 'hapi-blocked-alert-mode'
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

function parseBlockedAlertMode(raw: string | null): BlockedAlertMode {
    if (raw === 'count' || raw === 'pulse' || raw === 'sound') return raw
    return DEFAULT_BLOCKED_ALERT_MODE
}

export function getInitialBlockedAlertMode(): BlockedAlertMode {
    return parseBlockedAlertMode(safeGetItem(storageKey()))
}

export function useBlockedAlertMode(): {
    blockedAlertMode: BlockedAlertMode
    setBlockedAlertMode: (mode: BlockedAlertMode) => void
} {
    const [blockedAlertMode, setState] = useState<BlockedAlertMode>(getInitialBlockedAlertMode)

    useEffect(() => {
        if (!isBrowser()) return
        const onStorage = (event: StorageEvent) => {
            if (event.key !== storageKey()) return
            setState(parseBlockedAlertMode(event.newValue))
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setBlockedAlertMode = useCallback((mode: BlockedAlertMode) => {
        setState(mode)
        if (mode === DEFAULT_BLOCKED_ALERT_MODE) {
            safeRemoveItem(storageKey())
        } else {
            safeSetItem(storageKey(), mode)
        }
    }, [])

    return { blockedAlertMode, setBlockedAlertMode }
}
