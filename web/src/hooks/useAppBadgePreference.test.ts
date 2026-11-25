import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_APP_BADGE_ENABLED,
    getInitialAppBadgeEnabled,
    useAppBadgePreference,
} from './useAppBadgePreference'

const STORAGE_KEY = 'hapi-app-badge-enabled'

describe('useAppBadgePreference helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to disabled', () => {
        expect(getInitialAppBadgeEnabled()).toBe(DEFAULT_APP_BADGE_ENABLED)
        expect(getInitialAppBadgeEnabled()).toBe(false)
    })

    it('reads the stored enabled value and falls back for other values', () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        expect(getInitialAppBadgeEnabled()).toBe(true)

        window.localStorage.setItem(STORAGE_KEY, 'invalid')
        expect(getInitialAppBadgeEnabled()).toBe(false)
    })
})

describe('useAppBadgePreference', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('persists changes and synchronizes hook instances in the same tab', () => {
        const first = renderHook(() => useAppBadgePreference())
        const second = renderHook(() => useAppBadgePreference())

        act(() => first.result.current.setAppBadgeEnabled(true))

        expect(first.result.current.appBadgeEnabled).toBe(true)
        expect(second.result.current.appBadgeEnabled).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')

        act(() => second.result.current.setAppBadgeEnabled(false))

        expect(first.result.current.appBadgeEnabled).toBe(false)
        expect(second.result.current.appBadgeEnabled).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('synchronizes changes from another browsing context', () => {
        const { result } = renderHook(() => useAppBadgePreference())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: 'true',
            }))
        })

        expect(result.current.appBadgeEnabled).toBe(true)
    })

    it('ignores storage events for unrelated keys', () => {
        const { result } = renderHook(() => useAppBadgePreference())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'hapi-other-setting',
                newValue: 'false',
            }))
        })

        expect(result.current.appBadgeEnabled).toBe(false)
    })
})
