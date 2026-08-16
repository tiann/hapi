// The /sessions layout keeps its sidebar mounted while its child route changes.
// TanStack Router restores every scrollable element by default, so a cached child
// route can otherwise overwrite the sidebar's current scrollTop. The child panes
// own their own scroll state; internal workspace navigation should skip the
// router-wide restoration pass.
export const PRESERVE_SESSION_SIDEBAR_SCROLL = {
    resetScroll: false,
} as const

export function getSessionListSelectionNavigation(sessionId: string) {
    return {
        to: '/sessions/$sessionId' as const,
        params: { sessionId },
        ...PRESERVE_SESSION_SIDEBAR_SCROLL,
    }
}
