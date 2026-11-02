import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionListView, useSessionListView } from './useSessionListView'
import { useShowActiveSessionsOnly } from './useShowActiveSessionsOnly'

afterEach(() => {
    localStorage.clear()
})

describe('useSessionListView', () => {
    it('defaults to last-message order, all sessions and active first', () => {
        expect(readSessionListView()).toEqual({ sort: 'last-message', status: 'all', activeFirst: true })
    })

    it('falls back to defaults for unknown stored values', () => {
        localStorage.setItem('hapi-session-list-sort', 'activity')
        localStorage.setItem('hapi-session-list-status', 'bogus')
        expect(readSessionListView()).toEqual({ sort: 'last-message', status: 'all', activeFirst: true })
    })

    it('carries the legacy active-only setting over as the Active status', () => {
        localStorage.setItem('hapi-show-active-sessions-only', 'true')
        expect(readSessionListView().status).toBe('active')
    })

    it('persists choices, storing defaults as absent keys', () => {
        const { result } = renderHook(() => useSessionListView())
        act(() => result.current.setView({ sort: 'created', status: 'archived', activeFirst: false }))
        expect(result.current.view).toEqual({ sort: 'created', status: 'archived', activeFirst: false })
        expect(readSessionListView()).toEqual({ sort: 'created', status: 'archived', activeFirst: false })

        act(() => result.current.setView({ sort: 'last-message', status: 'all', activeFirst: true }))
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
})
