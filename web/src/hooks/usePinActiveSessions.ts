import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-pin-active-sessions'
const CHANGE_EVENT = 'hapi-pin-active-sessions-change'

function readPreference(): boolean {
    if (typeof window === 'undefined') return false
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

export function usePinActiveSessions(): {
    pinActiveSessions: boolean
    setPinActiveSessions: (value: boolean) => void
} {
    const [pinActiveSessions, setPinActiveSessionsState] = useState(readPreference)

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) {
                setPinActiveSessionsState(event.newValue === 'true')
            }
        }
        const onLocalChange = (event: Event) => {
            if (event instanceof CustomEvent && typeof event.detail === 'boolean') {
                setPinActiveSessionsState(event.detail)
            }
        }
        window.addEventListener('storage', onStorage)
        window.addEventListener(CHANGE_EVENT, onLocalChange)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(CHANGE_EVENT, onLocalChange)
        }
    }, [])

    const setPinActiveSessions = useCallback((value: boolean) => {
        setPinActiveSessionsState(value)
        try {
            if (value) {
                localStorage.setItem(STORAGE_KEY, 'true')
            } else {
                localStorage.removeItem(STORAGE_KEY)
            }
        } catch {
            // Ignore storage errors.
        }
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }))
    }, [])

    return { pinActiveSessions, setPinActiveSessions }
}
