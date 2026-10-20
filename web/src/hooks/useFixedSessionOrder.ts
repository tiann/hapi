import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_FIXED_SESSION_ORDER = false

function getFixedSessionOrderStorageKey(): string {
    return 'hapi-fixed-session-order'
}

const SAME_TAB_LISTENERS = new Set<(value: boolean) => void>()

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

function parseFixedSessionOrder(raw: string | null): boolean {
    if (raw === 'true') {
        return true
    }
    return DEFAULT_FIXED_SESSION_ORDER
}

export function getInitialFixedSessionOrder(): boolean {
    return parseFixedSessionOrder(safeGetItem(getFixedSessionOrderStorageKey()))
}

export function useFixedSessionOrder(): {
    fixedSessionOrder: boolean
    setFixedSessionOrder: (value: boolean) => void
} {
    const [fixedSessionOrder, setFixedSessionOrderState] = useState<boolean>(getInitialFixedSessionOrder)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getFixedSessionOrderStorageKey()) {
                return
            }
            setFixedSessionOrderState(parseFixedSessionOrder(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        // Storage events only fire in OTHER tabs; keep hook instances in the
        // same tab (App + SessionList both consume this) in sync directly.
        SAME_TAB_LISTENERS.add(setFixedSessionOrderState)
        return () => {
            SAME_TAB_LISTENERS.delete(setFixedSessionOrderState)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    const setFixedSessionOrder = useCallback((value: boolean) => {
        for (const listener of SAME_TAB_LISTENERS) {
            listener(value)
        }
        setFixedSessionOrderState(value)

        if (value === DEFAULT_FIXED_SESSION_ORDER) {
            safeRemoveItem(getFixedSessionOrderStorageKey())
        } else {
            safeSetItem(getFixedSessionOrderStorageKey(), String(value))
        }
    }, [])

    return { fixedSessionOrder, setFixedSessionOrder }
}
