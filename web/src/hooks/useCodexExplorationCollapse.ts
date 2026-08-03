import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_CODEX_EXPLORATION_COLLAPSED = true

const CODEX_EXPLORATION_COLLAPSED_STORAGE_KEY = 'hapi-codex-exploration-collapsed'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(CODEX_EXPLORATION_COLLAPSED_STORAGE_KEY)
    } catch {
        return null
    }
}

function safeSetItem(value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(CODEX_EXPLORATION_COLLAPSED_STORAGE_KEY, value)
    } catch {
        // Ignore storage errors.
    }
}

function safeRemoveItem(): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(CODEX_EXPLORATION_COLLAPSED_STORAGE_KEY)
    } catch {
        // Ignore storage errors.
    }
}

function parseCodexExplorationCollapsed(raw: string | null): boolean {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return DEFAULT_CODEX_EXPLORATION_COLLAPSED
}

export function getInitialCodexExplorationCollapsed(): boolean {
    return parseCodexExplorationCollapsed(safeGetItem())
}

export function useCodexExplorationCollapse(): {
    codexExplorationCollapsed: boolean
    setCodexExplorationCollapsed: (value: boolean) => void
} {
    const [codexExplorationCollapsed, setCodexExplorationCollapsedState] = useState<boolean>(getInitialCodexExplorationCollapsed)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== CODEX_EXPLORATION_COLLAPSED_STORAGE_KEY) return
            setCodexExplorationCollapsedState(parseCodexExplorationCollapsed(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setCodexExplorationCollapsed = useCallback((value: boolean) => {
        setCodexExplorationCollapsedState(value)
        if (value === DEFAULT_CODEX_EXPLORATION_COLLAPSED) {
            safeRemoveItem()
        } else {
            safeSetItem(String(value))
        }
    }, [])

    return { codexExplorationCollapsed, setCodexExplorationCollapsed }
}
