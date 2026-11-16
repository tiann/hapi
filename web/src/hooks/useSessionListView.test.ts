import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionListView, updateSessionListView, useSessionListView } from './useSessionListView'
import { useShowActiveSessionsOnly } from './useShowActiveSessionsOnly'

afterEach(() => {
    localStorage.clear()
})

describe('useSessionListView', () => {
    it('defaults to last-message order, all sessions and active first', () => {
        expect(readSessionListView()).toEqual({ sort: 'last-message', status: 'all', activeFirst: true, unreadOnly: false, compactRows: false, showPresenceBadge: true })
    })

    it('falls back to defaults for unknown stored values', () => {
        localStorage.setItem('hapi-session-list-sort', 'activity')
        localStorage.setItem('hapi-session-list-status', 'bogus')
        expect(readSessionListView()).toEqual({ sort: 'last-message', status: 'all', activeFirst: true, unreadOnly: false, compactRows: false, showPresenceBadge: true })
    })

    it('carries the legacy active-only setting over as the Active status', () => {
        localStorage.setItem('hapi-show-active-sessions-only', 'true')
        expect(readSessionListView().status).toBe('active')
    })

    it('persists choices, storing defaults as absent keys', () => {
        const { result } = renderHook(() => useSessionListView())
        act(() => result.current.setView({ sort: 'created', status: 'archived', activeFirst: false, unreadOnly: true, compactRows: false, showPresenceBadge: true }))
        expect(result.current.view).toEqual({ sort: 'created', status: 'archived', activeFirst: false, unreadOnly: true, compactRows: false, showPresenceBadge: true })
        expect(readSessionListView()).toEqual({ sort: 'created', status: 'archived', activeFirst: false, unreadOnly: true, compactRows: false, showPresenceBadge: true })

        act(() => result.current.setView({ sort: 'last-message', status: 'all', activeFirst: true, unreadOnly: false, compactRows: false, showPresenceBadge: true }))
        expect(localStorage.length).toBe(0)
    })

    it('persists the unread-only filter, off by default', () => {
        expect(readSessionListView().unreadOnly).toBe(false)
        const { result } = renderHook(() => useSessionListView())
        act(() => result.current.setView({ unreadOnly: true }))
        expect(localStorage.getItem('hapi-session-list-unread-only')).toBe('true')
        expect(readSessionListView().unreadOnly).toBe(true)
        act(() => result.current.setView({ unreadOnly: false }))
        expect(localStorage.length).toBe(0)
    })

    it('keeps the settings switch and the list menu in sync', () => {
        const list = renderHook(() => useSessionListView())
        const settings = renderHook(() => useShowActiveSessionsOnly())
        act(() => settings.result.current.setShowActiveSessionsOnly(true))
        expect(list.result.current.view.status).toBe('active')
        act(() => list.result.current.setView({ status: 'archived' }))
        expect(settings.result.current.showActiveSessionsOnly).toBe(false)
    })

    it('persists compact rows and presence badge, storing defaults as absent keys', () => {
        updateSessionListView({ compactRows: true, showPresenceBadge: false })
        expect(readSessionListView()).toEqual({
            sort: 'last-message', status: 'all', activeFirst: true, unreadOnly: false,
            compactRows: true, showPresenceBadge: false
        })
        expect(localStorage.getItem('hapi-session-list-compact-rows')).toBe('true')
        expect(localStorage.getItem('hapi-session-list-show-presence-badge')).toBe('false')

        updateSessionListView({ compactRows: false, showPresenceBadge: true })
        expect(localStorage.getItem('hapi-session-list-compact-rows')).toBeNull()
        expect(localStorage.getItem('hapi-session-list-show-presence-badge')).toBeNull()
    })

    it('treats any non-true boolean pref value as false, matching the other boolean prefs', () => {
        localStorage.setItem('hapi-session-list-compact-rows', 'yes')
        localStorage.setItem('hapi-session-list-show-presence-badge', 'no')
        expect(readSessionListView().compactRows).toBe(false)
        expect(readSessionListView().showPresenceBadge).toBe(false)
    })

})
