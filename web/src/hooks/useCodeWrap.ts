import { useCallback, useEffect, useState } from 'react'

function getCodeWrapStorageKey(): string {
    return 'hapi-code-wrap'
}

// `storage` events only fire in *other* browsing contexts (tabs/windows),
// never in the document that made the write. Code blocks render many
// independent `useCodeWrap()` instances in the same tab (CodeBlock,
// markdown Pre, DiffView all read the same preference), so a same-tab
// in-memory broadcast is required to keep every instance in sync when one
// of them toggles the value.
const sameTabListeners = new Set<(wrap: boolean) => void>()

function broadcastSameTab(wrap: boolean): void {
    for (const listener of sameTabListeners) {
        listener(wrap)
    }
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

function parseCodeWrap(raw: string | null): boolean {
    return raw === '1'
}

export function getInitialCodeWrap(): boolean {
    return parseCodeWrap(safeGetItem(getCodeWrapStorageKey()))
}

export function useCodeWrap(): {
    codeWrap: boolean
    setCodeWrap: (wrap: boolean) => void
} {
    const [codeWrap, setCodeWrapState] = useState<boolean>(getInitialCodeWrap)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getCodeWrapStorageKey()) {
                return
            }
            setCodeWrapState(parseCodeWrap(event.newValue))
        }

        sameTabListeners.add(setCodeWrapState)
        window.addEventListener('storage', onStorage)
        return () => {
            sameTabListeners.delete(setCodeWrapState)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    const setCodeWrap = useCallback((wrap: boolean) => {
        // Broadcast only: every mounted instance (including this one, which
        // registered its own `setCodeWrapState` as a listener on mount)
        // updates through the same path, so the initiating instance is not
        // double-set. Toggle buttons fire from onClick handlers, which React
        // guarantees run after the mount effect, so this instance's listener
        // is always registered by the time this runs.
        broadcastSameTab(wrap)

        if (wrap) {
            safeSetItem(getCodeWrapStorageKey(), '1')
        } else {
            safeRemoveItem(getCodeWrapStorageKey())
        }
    }, [])

    return { codeWrap, setCodeWrap }
}
