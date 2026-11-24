import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-show-mobile-machine-filter'
export const DEFAULT_SHOW_MOBILE_MACHINE_FILTER = false

const listeners = new Set<(enabled: boolean) => void>()

function readPreference(): boolean {
    if (typeof window === 'undefined') return DEFAULT_SHOW_MOBILE_MACHINE_FILTER
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
        return DEFAULT_SHOW_MOBILE_MACHINE_FILTER
    }
}

export function useShowMobileMachineFilter(): {
    showMobileMachineFilter: boolean
    setShowMobileMachineFilter: (enabled: boolean) => void
} {
    const [showMobileMachineFilter, setState] = useState(readPreference)

    useEffect(() => {
        listeners.add(setState)
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) setState(event.newValue === 'true')
        }
        window.addEventListener('storage', onStorage)
        return () => {
            listeners.delete(setState)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    const setShowMobileMachineFilter = useCallback((enabled: boolean) => {
        for (const listener of listeners) listener(enabled)
        try {
            if (enabled === DEFAULT_SHOW_MOBILE_MACHINE_FILTER) localStorage.removeItem(STORAGE_KEY)
            else localStorage.setItem(STORAGE_KEY, String(enabled))
        } catch {
            // Ignore storage errors.
        }
    }, [])

    return { showMobileMachineFilter, setShowMobileMachineFilter }
}
