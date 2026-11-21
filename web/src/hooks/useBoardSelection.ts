import { useCallback, useEffect, useState } from 'react'

function getBoardSelectionStorageKey(): string {
    return 'hapi-board-selection'
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

export function getInitialBoardSelection(): string | null {
    const raw = safeGetItem(getBoardSelectionStorageKey())
    return raw && raw.trim().length > 0 ? raw : null
}

/** Last-selected board persists across reopening To-Do mode (hapi#235). */
export function useBoardSelection(): {
    selectedBoardId: string | null
    setSelectedBoardId: (id: string) => void
} {
    const [selectedBoardId, setSelectedBoardIdState] = useState<string | null>(getInitialBoardSelection)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getBoardSelectionStorageKey()) {
                return
            }
            setSelectedBoardIdState(event.newValue && event.newValue.trim().length > 0 ? event.newValue : null)
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setSelectedBoardId = useCallback((id: string) => {
        setSelectedBoardIdState(id)
        safeSetItem(getBoardSelectionStorageKey(), id)
    }, [])

    return { selectedBoardId, setSelectedBoardId }
}
