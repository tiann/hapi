import { useCallback, useEffect, useState } from 'react'
import type { ToolGroupingMode } from '@/chat/toolGroups'

export const DEFAULT_TOOL_GROUPING_MODE: ToolGroupingMode = 'grouped'

export function getToolGroupingModeOptions(): ReadonlyArray<{ value: ToolGroupingMode; labelKey: string }> {
    return [
        { value: 'grouped', labelKey: 'settings.chat.toolGrouping.grouped' },
        { value: 'classified', labelKey: 'settings.chat.toolGrouping.classified' },
    ]
}

const STORAGE_KEY = 'hapi-tool-grouping-mode'
const CHANGE_EVENT = 'hapi-tool-grouping-mode-change'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function parseToolGroupingMode(raw: string | null): ToolGroupingMode {
    return raw === 'grouped' || raw === 'classified'
        ? raw
        : DEFAULT_TOOL_GROUPING_MODE
}

export function getInitialToolGroupingMode(): ToolGroupingMode {
    if (!isBrowser()) return DEFAULT_TOOL_GROUPING_MODE
    try {
        return parseToolGroupingMode(localStorage.getItem(STORAGE_KEY))
    } catch {
        return DEFAULT_TOOL_GROUPING_MODE
    }
}

export function useToolGroupingMode(): {
    toolGroupingMode: ToolGroupingMode
    setToolGroupingMode: (mode: ToolGroupingMode) => void
} {
    const [toolGroupingMode, setToolGroupingModeState] = useState<ToolGroupingMode>(getInitialToolGroupingMode)

    useEffect(() => {
        if (!isBrowser()) return
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) {
                setToolGroupingModeState(parseToolGroupingMode(event.newValue))
            }
        }
        const onChange = () => {
            setToolGroupingModeState(getInitialToolGroupingMode())
        }
        window.addEventListener('storage', onStorage)
        window.addEventListener(CHANGE_EVENT, onChange)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(CHANGE_EVENT, onChange)
        }
    }, [])

    const setToolGroupingMode = useCallback((mode: ToolGroupingMode) => {
        setToolGroupingModeState(mode)
        try {
            if (mode === DEFAULT_TOOL_GROUPING_MODE) {
                localStorage.removeItem(STORAGE_KEY)
            } else {
                localStorage.setItem(STORAGE_KEY, mode)
            }
            window.dispatchEvent(new Event(CHANGE_EVENT))
        } catch {
            // Ignore storage errors
        }
    }, [])

    return { toolGroupingMode, setToolGroupingMode }
}
