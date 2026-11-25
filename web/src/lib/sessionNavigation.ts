// The /sessions layout keeps its sidebar mounted while its child route changes.
// TanStack Router restores every scrollable element by default, so a cached child
// route can otherwise overwrite the sidebar's current scrollTop. The child panes
// own their own scroll state; internal workspace navigation should skip the
// router-wide restoration pass.
export const PRESERVE_SESSION_SIDEBAR_SCROLL = {
    resetScroll: false,
} as const

export const SESSION_SIDEBAR_HIDDEN = 'hidden' as const

export function isSessionSidebarHidden(search: unknown): boolean {
    if (!search || typeof search !== 'object') return false
    return (search as { sidebar?: unknown }).sidebar === SESSION_SIDEBAR_HIDDEN
}

export function shouldShowSessionSidebar(pathname: string, search: unknown): boolean {
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    return isSessionsIndex || !isSessionSidebarHidden(search)
}

export function buildSessionWindowPath(sessionId: string): string {
    const base = import.meta.env.BASE_URL ?? '/'
    const normalizedBase = base.endsWith('/') ? base : `${base}/`
    const path = `${normalizedBase}sessions/${encodeURIComponent(sessionId)}`.replace(/\/{2,}/g, '/')
    return `${path}?sidebar=${SESSION_SIDEBAR_HIDDEN}`
}

export function getSessionListSelectionNavigation(
    sessionId: string,
    options?: { sidebar?: typeof SESSION_SIDEBAR_HIDDEN },
) {
    return {
        to: '/sessions/$sessionId' as const,
        params: { sessionId },
        ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        ...(options?.sidebar ? { search: { sidebar: options.sidebar } } : {}),
    }
}
