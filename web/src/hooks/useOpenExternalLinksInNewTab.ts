import { useCallback, useEffect, useState } from 'react'

const OPEN_EXTERNAL_LINKS_IN_NEW_TAB_STORAGE_KEY = 'hapi-open-external-links-in-new-tab'
export const DEFAULT_OPEN_EXTERNAL_LINKS_IN_NEW_TAB = false

// Same-tab sync: `storage` events only fire in OTHER tabs/windows, but several
// <UriConfirmProvider> instances can coexist in one window (e.g. one per
// chat message), each with its own useState. Without this, toggling the
// setting in Settings would only affect providers mounted after the change.
const sameTabListeners = new Set<(value: boolean) => void>()

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

function parseOpenExternalLinksInNewTab(raw: string | null): boolean {
    if (raw === 'true') {
        return true
    }
    return DEFAULT_OPEN_EXTERNAL_LINKS_IN_NEW_TAB
}

export function getInitialOpenExternalLinksInNewTab(): boolean {
    return parseOpenExternalLinksInNewTab(safeGetItem(OPEN_EXTERNAL_LINKS_IN_NEW_TAB_STORAGE_KEY))
}

export function useOpenExternalLinksInNewTab(): {
    openExternalLinksInNewTab: boolean
    setOpenExternalLinksInNewTab: (value: boolean) => void
} {
    const [openExternalLinksInNewTab, setOpenExternalLinksInNewTabState] = useState<boolean>(getInitialOpenExternalLinksInNewTab)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== OPEN_EXTERNAL_LINKS_IN_NEW_TAB_STORAGE_KEY) {
                return
            }
            setOpenExternalLinksInNewTabState(parseOpenExternalLinksInNewTab(event.newValue))
        }

        sameTabListeners.add(setOpenExternalLinksInNewTabState)
        window.addEventListener('storage', onStorage)
        return () => {
            sameTabListeners.delete(setOpenExternalLinksInNewTabState)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    const setOpenExternalLinksInNewTab = useCallback((value: boolean) => {
        for (const listener of sameTabListeners) {
            listener(value)
        }

        if (value === DEFAULT_OPEN_EXTERNAL_LINKS_IN_NEW_TAB) {
            safeRemoveItem(OPEN_EXTERNAL_LINKS_IN_NEW_TAB_STORAGE_KEY)
        } else {
            safeSetItem(OPEN_EXTERNAL_LINKS_IN_NEW_TAB_STORAGE_KEY, String(value))
        }
    }, [])

    return { openExternalLinksInNewTab, setOpenExternalLinksInNewTab }
}
