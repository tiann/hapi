import { useCallback, useEffect, useState } from 'react'

/**
 * Sidebar "In progress" pin policy (ships with session-attached jobs #1404).
 *
 * Degree of float, not a yes/no:
 * - off  — everything stays in project directories
 * - jobs — only sessions with a running attachedJob (outliving work)
 * - all  — jobs + agent working/pending (UI: "Working & pending"; storage key
 *          stays `all` for migration). Quiet connected (socket up, idle) never floats.
 *
 * Unset / never configured defaults to `jobs` — the product stand for this capability.
 */

export type PinInProgressMode = 'off' | 'jobs' | 'all'

export const PIN_IN_PROGRESS_MODES: readonly PinInProgressMode[] = ['off', 'jobs', 'all'] as const

/** New default when the preference has never been set. */
export const DEFAULT_PIN_IN_PROGRESS_MODE: PinInProgressMode = 'jobs'

export const PIN_IN_PROGRESS_STORAGE_KEY = 'hapi-pin-in-progress-sessions'

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

/**
 * Parse stored value.
 * - absent / null → `jobs` (capability default)
 * - legacy `true` → `all`
 * - legacy `false` → `off`
 * - `off` | `jobs` | `all` → as written
 */
export function parsePinInProgressMode(raw: string | null): PinInProgressMode {
    if (raw === null || raw === '') {
        return DEFAULT_PIN_IN_PROGRESS_MODE
    }
    if (raw === 'true') {
        return 'all'
    }
    if (raw === 'false') {
        return 'off'
    }
    if (raw === 'off' || raw === 'jobs' || raw === 'all') {
        return raw
    }
    return DEFAULT_PIN_IN_PROGRESS_MODE
}

export function getInitialPinInProgressMode(): PinInProgressMode {
    const raw = safeGetItem(PIN_IN_PROGRESS_STORAGE_KEY)
    const mode = parsePinInProgressMode(raw)
    // Persist so explicit Off is distinguishable from never-set→jobs.
    // Legacy true/false also rewrite to all/off (upstream removed the key on false,
    // so those users already look like unset — product stand maps them to jobs).
    if (raw === null || raw === '' || raw === 'true' || raw === 'false') {
        safeSetItem(PIN_IN_PROGRESS_STORAGE_KEY, mode)
    }
    return mode
}

/** @deprecated Use getInitialPinInProgressMode — boolean form treated `all` as true. */
export function getInitialPinInProgressSessions(): boolean {
    return getInitialPinInProgressMode() !== 'off'
}

export function getPinInProgressModeOptions(): ReadonlyArray<{
    value: PinInProgressMode
    labelKey: string
}> {
    return [
        { value: 'off', labelKey: 'settings.display.pinInProgressMode.off' },
        { value: 'jobs', labelKey: 'settings.display.pinInProgressMode.jobs' },
        { value: 'all', labelKey: 'settings.display.pinInProgressMode.all' },
    ]
}

export function usePinInProgressSessions(): {
    pinInProgressMode: PinInProgressMode
    setPinInProgressMode: (value: PinInProgressMode) => void
    /** True when mode is not off (any pin bucket may show). */
    pinInProgressSessions: boolean
    /** @deprecated Prefer setPinInProgressMode. `true`→all, `false`→off. */
    setPinInProgressSessions: (value: boolean) => void
} {
    const [pinInProgressMode, setPinInProgressModeState] = useState<PinInProgressMode>(
        getInitialPinInProgressMode
    )

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== PIN_IN_PROGRESS_STORAGE_KEY) {
                return
            }
            setPinInProgressModeState(parsePinInProgressMode(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setPinInProgressMode = useCallback((value: PinInProgressMode) => {
        setPinInProgressModeState(value)
        // Always persist so an explicit Off is distinct from never-set→jobs default
        // after the user has opened Settings and chosen.
        safeSetItem(PIN_IN_PROGRESS_STORAGE_KEY, value)
    }, [])

    const setPinInProgressSessions = useCallback((value: boolean) => {
        setPinInProgressMode(value ? 'all' : 'off')
    }, [setPinInProgressMode])

    return {
        pinInProgressMode,
        setPinInProgressMode,
        pinInProgressSessions: pinInProgressMode !== 'off',
        setPinInProgressSessions
    }
}
