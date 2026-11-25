import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-mention-inactive-collapsed'
const listeners = new Set<(value: boolean) => void>()

function readPreference(): boolean {
    try {
        return typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

export function useMentionInactiveCollapsed() {
    const [mentionInactiveCollapsed, setState] = useState(readPreference)

    useEffect(() => {
        listeners.add(setState)
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY || event.key === null) {
                setState(event.key === null ? false : event.newValue === 'true')
            }
        }
        window.addEventListener('storage', onStorage)
        return () => {
            listeners.delete(setState)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    const setMentionInactiveCollapsed = useCallback((value: boolean) => {
        setState(value)
        for (const listener of listeners) listener(value)
        try {
            if (value) window.localStorage.setItem(STORAGE_KEY, 'true')
            else window.localStorage.removeItem(STORAGE_KEY)
        } catch {
            // The preference remains available for the current session.
        }
    }, [])

    return { mentionInactiveCollapsed, setMentionInactiveCollapsed }
}
