import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SESSION_PROJECT_SORT_MODE,
    getInitialSessionProjectSortMode,
    getSessionProjectSortModeOptions,
    useSessionProjectSortMode,
} from './useSessionProjectSortMode'

describe('useSessionProjectSortMode', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to recent activity and lists most sessions second', () => {
        expect(DEFAULT_SESSION_PROJECT_SORT_MODE).toBe('recent')
        expect(getInitialSessionProjectSortMode()).toBe('recent')
        expect(getSessionProjectSortModeOptions()).toEqual([
            { value: 'recent', labelKey: 'settings.display.projectSort.recent' },
            { value: 'count', labelKey: 'settings.display.projectSort.count' },
        ])
    })

    it('reads valid persisted mode and falls back for invalid values', () => {
        window.localStorage.setItem('hapi-session-project-sort-mode', 'recent')
        expect(getInitialSessionProjectSortMode()).toBe('recent')

        window.localStorage.setItem('hapi-session-project-sort-mode', 'invalid')
        expect(getInitialSessionProjectSortMode()).toBe('recent')

        window.localStorage.setItem('hapi-session-project-sort-mode', 'stable')
        expect(getInitialSessionProjectSortMode()).toBe('count')
    })

    it('synchronizes mode changes between hook instances', () => {
        const first = renderHook(() => useSessionProjectSortMode())
        const second = renderHook(() => useSessionProjectSortMode())

        act(() => first.result.current.setSessionProjectSortMode('recent'))
        expect(second.result.current.sessionProjectSortMode).toBe('recent')
        expect(window.localStorage.getItem('hapi-session-project-sort-mode')).toBeNull()

        act(() => second.result.current.setSessionProjectSortMode('count'))
        expect(first.result.current.sessionProjectSortMode).toBe('count')
        expect(window.localStorage.getItem('hapi-session-project-sort-mode')).toBe('count')
    })
})
