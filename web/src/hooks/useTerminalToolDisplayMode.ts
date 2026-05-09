import { useCallback, useEffect, useState } from 'react'

export type TerminalToolDisplayMode = 'compact' | 'detailed'

export const DEFAULT_TERMINAL_TOOL_DISPLAY_MODE: TerminalToolDisplayMode = 'compact'

export function getTerminalToolDisplayModeOptions(): ReadonlyArray<{ value: TerminalToolDisplayMode; labelKey: string }> {
    return [
        { value: 'compact', labelKey: 'settings.chat.terminalToolDisplay.compact' },
        { value: 'detailed', labelKey: 'settings.chat.terminalToolDisplay.detailed' },
    ]
}

function getTerminalToolDisplayModeStorageKey(): string {
    return 'hapi-terminal-tool-display-mode'
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

function parseTerminalToolDisplayMode(raw: string | null): TerminalToolDisplayMode {
    if (raw === 'compact' || raw === 'detailed') {
        return raw
    }
    return DEFAULT_TERMINAL_TOOL_DISPLAY_MODE
}

export function getInitialTerminalToolDisplayMode(): TerminalToolDisplayMode {
    return parseTerminalToolDisplayMode(safeGetItem(getTerminalToolDisplayModeStorageKey()))
}

export function useTerminalToolDisplayMode(): {
    terminalToolDisplayMode: TerminalToolDisplayMode
    setTerminalToolDisplayMode: (mode: TerminalToolDisplayMode) => void
} {
    const [terminalToolDisplayMode, setTerminalToolDisplayModeState] = useState<TerminalToolDisplayMode>(getInitialTerminalToolDisplayMode)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getTerminalToolDisplayModeStorageKey()) {
                return
            }
            setTerminalToolDisplayModeState(parseTerminalToolDisplayMode(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setTerminalToolDisplayMode = useCallback((mode: TerminalToolDisplayMode) => {
        setTerminalToolDisplayModeState(mode)

        if (mode === DEFAULT_TERMINAL_TOOL_DISPLAY_MODE) {
            safeRemoveItem(getTerminalToolDisplayModeStorageKey())
        } else {
            safeSetItem(getTerminalToolDisplayModeStorageKey(), mode)
        }
    }, [])

    return { terminalToolDisplayMode, setTerminalToolDisplayMode }
}
