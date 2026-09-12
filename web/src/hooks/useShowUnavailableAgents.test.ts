import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SHOW_UNAVAILABLE_AGENTS,
    getInitialShowUnavailableAgents,
    SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY,
    useShowUnavailableAgents,
} from './useShowUnavailableAgents'

describe('show unavailable Agents preference', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to hidden', () => {
        expect(getInitialShowUnavailableAgents()).toBe(DEFAULT_SHOW_UNAVAILABLE_AGENTS)
    })

    it('reads only an explicit true value as enabled', () => {
        window.localStorage.setItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY, 'true')
        expect(getInitialShowUnavailableAgents()).toBe(true)

        window.localStorage.setItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY, '1')
        expect(getInitialShowUnavailableAgents()).toBe(false)
    })
})

describe('useShowUnavailableAgents', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('persists enabling and removes the key when restored to the default', () => {
        const { result } = renderHook(() => useShowUnavailableAgents())

        act(() => result.current.setShowUnavailableAgents(true))
        expect(result.current.showUnavailableAgents).toBe(true)
        expect(window.localStorage.getItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY)).toBe('true')

        act(() => result.current.setShowUnavailableAgents(false))
        expect(result.current.showUnavailableAgents).toBe(false)
        expect(window.localStorage.getItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY)).toBeNull()
    })

    it('reacts to changes from another browsing context', () => {
        const { result } = renderHook(() => useShowUnavailableAgents())

        act(() => {
            window.localStorage.setItem(SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY, 'true')
            window.dispatchEvent(new StorageEvent('storage', {
                key: SHOW_UNAVAILABLE_AGENTS_STORAGE_KEY,
                newValue: 'true',
            }))
        })

        expect(result.current.showUnavailableAgents).toBe(true)
    })
})
