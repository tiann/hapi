import { useCallback, useEffect, useState } from 'react'

// null = "All machines" (no filtering). A string is a machine id, or
// UNKNOWN_MACHINE_ID ('__unknown__') for sessions without machine metadata.
export type SessionListMachineFilter = string | null

export const DEFAULT_SESSION_LIST_MACHINE_FILTER: SessionListMachineFilter = null

function getSessionListMachineFilterStorageKey(): string {
    return 'hapi-session-list-machine-filter'
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

function parseSessionListMachineFilter(raw: string | null): SessionListMachineFilter {
    return raw && raw.trim().length > 0 ? raw : DEFAULT_SESSION_LIST_MACHINE_FILTER
}

export function getInitialSessionListMachineFilter(): SessionListMachineFilter {
    return parseSessionListMachineFilter(safeGetItem(getSessionListMachineFilterStorageKey()))
}

export function useSessionListMachineFilter(): {
    machineFilter: SessionListMachineFilter
    setMachineFilter: (filter: SessionListMachineFilter) => void
} {
    const [machineFilter, setMachineFilterState] = useState<SessionListMachineFilter>(getInitialSessionListMachineFilter)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getSessionListMachineFilterStorageKey()) {
                return
            }
            setMachineFilterState(parseSessionListMachineFilter(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setMachineFilter = useCallback((filter: SessionListMachineFilter) => {
        setMachineFilterState(filter)

        if (filter === null) {
            safeRemoveItem(getSessionListMachineFilterStorageKey())
        } else {
            safeSetItem(getSessionListMachineFilterStorageKey(), filter)
        }
    }, [])

    return { machineFilter, setMachineFilter }
}
