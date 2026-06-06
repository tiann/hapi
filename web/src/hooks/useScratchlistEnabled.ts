import { useCallback, useEffect, useState } from 'react'

export const SCRATCHLIST_ENABLED_STORAGE_KEY = 'hapi-scratchlist-enabled'
export const DEFAULT_SCRATCHLIST_ENABLED = false

function isBrowser(): boolean {
    return typeof window !== 'undefined'
}

export function readScratchlistEnabledPreference(): boolean {
    if (!isBrowser()) return DEFAULT_SCRATCHLIST_ENABLED
    try {
        return window.localStorage.getItem(SCRATCHLIST_ENABLED_STORAGE_KEY) === 'true'
    } catch {
        return DEFAULT_SCRATCHLIST_ENABLED
    }
}

export function writeScratchlistEnabledPreference(enabled: boolean): void {
    if (!isBrowser()) return
    try {
        if (enabled === DEFAULT_SCRATCHLIST_ENABLED) {
            window.localStorage.removeItem(SCRATCHLIST_ENABLED_STORAGE_KEY)
        } else {
            window.localStorage.setItem(SCRATCHLIST_ENABLED_STORAGE_KEY, 'true')
        }
    } catch {
        // Ignore storage errors.
    }
}

export function useScratchlistEnabled(): [boolean, (enabled: boolean) => void] {
    const [enabled, setEnabledState] = useState<boolean>(readScratchlistEnabledPreference)

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key !== SCRATCHLIST_ENABLED_STORAGE_KEY) return
            setEnabledState(readScratchlistEnabledPreference())
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setEnabled = useCallback((next: boolean) => {
        setEnabledState(next)
        writeScratchlistEnabledPreference(next)
    }, [])

    return [enabled, setEnabled]
}
