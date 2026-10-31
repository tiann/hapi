import { describe, expect, it } from 'vitest'
import {
    buildSessionWindowPath,
    getSessionListSelectionNavigation,
    isSessionSidebarHidden,
    PRESERVE_SESSION_SIDEBAR_SCROLL,
    shouldShowSessionSidebar,
} from './sessionNavigation'

describe('PRESERVE_SESSION_SIDEBAR_SCROLL', () => {
    it('skips router-wide scroll restoration for internal session navigation', () => {
        expect(PRESERVE_SESSION_SIDEBAR_SCROLL).toEqual({ resetScroll: false })
    })
})

describe('getSessionListSelectionNavigation', () => {
    it('preserves the shared sidebar scroll position when selecting a session', () => {
        expect(getSessionListSelectionNavigation('session-active')).toEqual({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-active' },
            resetScroll: false,
        })
    })

    it('preserves hidden-sidebar state when selecting another session', () => {
        expect(getSessionListSelectionNavigation('session-focused', { sidebar: 'hidden' })).toEqual({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-focused' },
            resetScroll: false,
            search: { sidebar: 'hidden' },
        })
    })
})

describe('session separate-window navigation', () => {
    it('builds a base-aware hidden-sidebar session path', () => {
        expect(buildSessionWindowPath('session /?')).toBe('/sessions/session%20%2F%3F?sidebar=hidden')
    })

    it('recognizes only the explicit hidden-sidebar search value', () => {
        expect(isSessionSidebarHidden({ sidebar: 'hidden' })).toBe(true)
        expect(isSessionSidebarHidden({ sidebar: 'visible' })).toBe(false)
        expect(isSessionSidebarHidden({})).toBe(false)
        expect(isSessionSidebarHidden(null)).toBe(false)
    })

    it('keeps the session index visible and hides the split sidebar only when requested', () => {
        expect(shouldShowSessionSidebar('/sessions', { sidebar: 'hidden' })).toBe(true)
        expect(shouldShowSessionSidebar('/sessions/session-1', {})).toBe(true)
        expect(shouldShowSessionSidebar('/sessions/session-1', { sidebar: 'hidden' })).toBe(false)
    })
})
