import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_SHOW_UNAVAILABLE_AGENTS = false
export const SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY = 'hapi-show-unavailable-agents'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY)
    } catch {
        return null
    }
}

function safeSetItem(value: boolean): void {
    if (!isBrowser()) return
    try {
        if (value === DEFAULT_SHOW_UNAVAILABLE_AGENTS) {
            localStorage.removeItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY)
        } else {
            localStorage.setItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY, String(value))
        }
    } catch {
        // Ignore storage errors.
    }
}

function parseShowUnavailableAgents(raw: string | null): boolean {
    return raw === 'true' ? true : DEFAULT_SHOW_UNAVAILABLE_AGENTS
}

export function getInitialShowUnavailableAgents(): boolean {
    return parseShowUnavailableAgents(safeGetItem())
}

export function useShowUnavailableAgents(): {
    showUnavailableAgents: boolean
    setShowUnavailableAgents: (value: boolean) => void
} {
    const [showUnavailableAgents, setShowUnavailableAgentsState] = useState<boolean>(getInitialShowUnavailableAgents)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY) return
            setShowUnavailableAgentsState(parseShowUnavailableAgents(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setShowUnavailableAgents = useCallback((value: boolean) => {
        setShowUnavailableAgentsState(value)
        safeSetItem(value)
    }, [])

    return { showUnavailableAgents, setShowUnavailableAgents }
}
