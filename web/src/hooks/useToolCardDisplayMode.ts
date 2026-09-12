import { useCallback, useEffect, useState } from 'react'
import type { ToolGroupingMode } from '@/chat/toolGroups'

export type ToolCardDisplayMode = 'grouped' | 'compact' | 'detailed'
export type TerminalToolDisplayMode = 'compact' | 'detailed'

export const DEFAULT_TOOL_CARD_DISPLAY_MODE: ToolCardDisplayMode = 'grouped'

const STORAGE_KEY = 'hapi-tool-card-display-mode'
const LEGACY_GROUPING_STORAGE_KEY = 'hapi-tool-grouping-mode'
const LEGACY_TERMINAL_STORAGE_KEY = 'hapi-terminal-tool-display-mode'
const CHANGE_EVENT = 'hapi-tool-card-display-mode-change'

export function getToolCardDisplayModeOptions(): ReadonlyArray<{ value: ToolCardDisplayMode; labelKey: string }> {
    return [
        { value: 'grouped', labelKey: 'settings.chat.toolCardDisplay.grouped' },
        { value: 'compact', labelKey: 'settings.chat.toolCardDisplay.compact' },
        { value: 'detailed', labelKey: 'settings.chat.toolCardDisplay.detailed' },
    ]
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors.
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors.
    }
}

function parseToolCardDisplayMode(raw: string | null): ToolCardDisplayMode | null {
    return raw === 'grouped' || raw === 'compact' || raw === 'detailed' ? raw : null
}

export function getInitialToolCardDisplayMode(): ToolCardDisplayMode {
    const unifiedMode = parseToolCardDisplayMode(safeGetItem(STORAGE_KEY))
    if (unifiedMode) return unifiedMode

    const legacyGroupingMode = safeGetItem(LEGACY_GROUPING_STORAGE_KEY)
    const legacyTerminalMode = safeGetItem(LEGACY_TERMINAL_STORAGE_KEY)

    if (legacyGroupingMode === 'grouped') return 'grouped'
    if (legacyGroupingMode === 'classified') {
        return legacyTerminalMode === 'detailed' ? 'detailed' : 'compact'
    }

    // Before tool grouping existed, terminal detail was the only explicit
    // preference. Preserve it instead of silently replacing it with grouping.
    if (legacyTerminalMode === 'detailed') return 'detailed'
    return DEFAULT_TOOL_CARD_DISPLAY_MODE
}

export function getToolCardDisplayPresentation(mode: ToolCardDisplayMode): {
    groupingMode: ToolGroupingMode
    terminalToolDisplayMode: TerminalToolDisplayMode
} {
    return {
        groupingMode: mode === 'grouped' ? 'grouped' : 'classified',
        terminalToolDisplayMode: mode === 'detailed' ? 'detailed' : 'compact',
    }
}

export function useToolCardDisplayMode(): {
    toolCardDisplayMode: ToolCardDisplayMode
    setToolCardDisplayMode: (mode: ToolCardDisplayMode) => void
} {
    const [toolCardDisplayMode, setToolCardDisplayModeState] = useState<ToolCardDisplayMode>(getInitialToolCardDisplayMode)

    useEffect(() => {
        if (!isBrowser()) return

        const syncFromStorage = () => setToolCardDisplayModeState(getInitialToolCardDisplayMode())
        const onChange = (event: Event) => {
            const detail = (event as CustomEvent<unknown>).detail
            const mode = parseToolCardDisplayMode(typeof detail === 'string' ? detail : null)
            setToolCardDisplayModeState(mode ?? getInitialToolCardDisplayMode())
        }
        const onStorage = (event: StorageEvent) => {
            if (
                event.key === STORAGE_KEY
                || event.key === LEGACY_GROUPING_STORAGE_KEY
                || event.key === LEGACY_TERMINAL_STORAGE_KEY
            ) {
                syncFromStorage()
            }
        }

        window.addEventListener('storage', onStorage)
        window.addEventListener(CHANGE_EVENT, onChange)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(CHANGE_EVENT, onChange)
        }
    }, [])

    const setToolCardDisplayMode = useCallback((mode: ToolCardDisplayMode) => {
        setToolCardDisplayModeState(mode)
        safeRemoveItem(LEGACY_GROUPING_STORAGE_KEY)
        safeRemoveItem(LEGACY_TERMINAL_STORAGE_KEY)
        if (mode === DEFAULT_TOOL_CARD_DISPLAY_MODE) {
            safeRemoveItem(STORAGE_KEY)
        } else {
            safeSetItem(STORAGE_KEY, mode)
        }
        if (isBrowser()) window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: mode }))
    }, [])

    return { toolCardDisplayMode, setToolCardDisplayMode }
}
