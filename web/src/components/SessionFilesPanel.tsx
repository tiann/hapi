import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Viewport width at which the session files/file routes open as a resizable
 * third column next to the chat instead of replacing it. Below this the
 * sessions sidebar + chat + files panel cannot all fit comfortably, so the
 * files routes keep their full-pane behavior.
 */
export const SESSION_FILES_PANEL_QUERY = '(min-width: 1200px)'

export const SESSION_FILES_PANEL_RESIZE = {
    storageKey: 'hapi-files-panel-width',
    minWidth: 320,
    maxWidth: 900,
    defaultWidth: 480,
    side: 'right',
} as const

export function useSessionFilesPanelAvailable(): boolean {
    const [matches, setMatches] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(SESSION_FILES_PANEL_QUERY).matches
    ))

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return
        }
        const mql = window.matchMedia(SESSION_FILES_PANEL_QUERY)
        const update = () => setMatches(mql.matches)
        update()
        mql.addEventListener('change', update)
        return () => mql.removeEventListener('change', update)
    }, [])

    return matches
}

type SessionFilesPanelState = {
    /** Files panel is open beside the chat (consumed by the chat header toggle). */
    open: boolean
    /** Content is rendered inside the side panel rather than as a full pane. */
    inPanel: boolean
    close: () => void
}

const SessionFilesPanelContext = createContext<SessionFilesPanelState | null>(null)

export const SessionFilesPanelProvider = SessionFilesPanelContext.Provider

export function useSessionFilesPanel(): SessionFilesPanelState | null {
    return useContext(SessionFilesPanelContext)
}
