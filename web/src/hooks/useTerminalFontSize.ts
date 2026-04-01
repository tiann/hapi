import { useCallback, useEffect, useState } from 'react'

const TERMINAL_FONT_SIZES = [9, 11, 13, 15, 17] as const

export type TerminalFontSize = typeof TERMINAL_FONT_SIZES[number]

export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 13

export function getTerminalFontSizeOptions(): ReadonlyArray<{ value: TerminalFontSize; label: string }> {
    return TERMINAL_FONT_SIZES.map(value => ({ value, label: `${value}px` }))
}

function getTerminalFontSizeStorageKey(): string {
    return 'hapi-terminal-font-size'
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

function parseTerminalFontSize(raw: string | null): TerminalFontSize {
    const value = Number(raw)
    return TERMINAL_FONT_SIZES.find(size => size === value) ?? DEFAULT_TERMINAL_FONT_SIZE
}

export function getInitialTerminalFontSize(): TerminalFontSize {
    return parseTerminalFontSize(safeGetItem(getTerminalFontSizeStorageKey()))
}

export function useTerminalFontSize(): {
    terminalFontSize: TerminalFontSize
    setTerminalFontSize: (size: TerminalFontSize) => void
} {
    const [terminalFontSize, setTerminalFontSizeState] = useState<TerminalFontSize>(getInitialTerminalFontSize)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getTerminalFontSizeStorageKey()) {
                return
            }
            setTerminalFontSizeState(parseTerminalFontSize(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setTerminalFontSize = useCallback((size: TerminalFontSize) => {
        setTerminalFontSizeState(size)

        if (size === DEFAULT_TERMINAL_FONT_SIZE) {
            safeRemoveItem(getTerminalFontSizeStorageKey())
        } else {
            safeSetItem(getTerminalFontSizeStorageKey(), String(size))
        }
    }, [])

    return { terminalFontSize, setTerminalFontSize }
}
