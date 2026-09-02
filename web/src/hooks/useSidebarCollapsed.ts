import { useCallback, useEffect, useState } from 'react'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'hapi-sidebar-collapsed-v1'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function readCollapsed(): boolean {
    if (!isBrowser()) return false
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

function writeCollapsed(collapsed: boolean): void {
    if (!isBrowser()) return
    try {
        if (collapsed) {
            localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true')
        } else {
            localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
        }
    } catch {
        // Ignore storage errors; the in-memory state still works for this tab.
    }
}

export function getInitialSidebarCollapsed(): boolean {
    return readCollapsed()
}

export function useSidebarCollapsed(): {
    sidebarCollapsed: boolean
    setSidebarCollapsed: (collapsed: boolean) => void
} {
    const [sidebarCollapsed, setSidebarCollapsedState] = useState(getInitialSidebarCollapsed)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== SIDEBAR_COLLAPSED_STORAGE_KEY) return
            setSidebarCollapsedState(event.newValue === 'true')
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setSidebarCollapsed = useCallback((collapsed: boolean) => {
        setSidebarCollapsedState(collapsed)
        writeCollapsed(collapsed)
    }, [])

    return { sidebarCollapsed, setSidebarCollapsed }
}
