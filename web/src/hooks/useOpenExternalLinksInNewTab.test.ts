import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_OPEN_EXTERNAL_LINKS_IN_NEW_TAB,
    getInitialOpenExternalLinksInNewTab,
    useOpenExternalLinksInNewTab,
} from './useOpenExternalLinksInNewTab'

const STORAGE_KEY = 'hapi-open-external-links-in-new-tab'

describe('useOpenExternalLinksInNewTab helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to disabled (today’s existing link behaviour)', () => {
        expect(getInitialOpenExternalLinksInNewTab()).toBe(DEFAULT_OPEN_EXTERNAL_LINKS_IN_NEW_TAB)
        expect(getInitialOpenExternalLinksInNewTab()).toBe(false)
    })

    it('reads the stored value and falls back for other values', () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        expect(getInitialOpenExternalLinksInNewTab()).toBe(true)

        window.localStorage.setItem(STORAGE_KEY, 'invalid')
        expect(getInitialOpenExternalLinksInNewTab()).toBe(false)
    })
})

describe('useOpenExternalLinksInNewTab', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('persists changes and synchronizes hook instances in the same tab', () => {
        const first = renderHook(() => useOpenExternalLinksInNewTab())
        const second = renderHook(() => useOpenExternalLinksInNewTab())

        act(() => first.result.current.setOpenExternalLinksInNewTab(true))

        expect(first.result.current.openExternalLinksInNewTab).toBe(true)
        expect(second.result.current.openExternalLinksInNewTab).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')

        act(() => second.result.current.setOpenExternalLinksInNewTab(false))

        expect(first.result.current.openExternalLinksInNewTab).toBe(false)
        expect(second.result.current.openExternalLinksInNewTab).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('synchronizes changes from another browsing context', () => {
        const { result } = renderHook(() => useOpenExternalLinksInNewTab())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: 'true',
            }))
        })

        expect(result.current.openExternalLinksInNewTab).toBe(true)
    })

    it('ignores storage events for unrelated keys', () => {
        const { result } = renderHook(() => useOpenExternalLinksInNewTab())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'hapi-other-setting',
                newValue: 'false',
            }))
        })

        expect(result.current.openExternalLinksInNewTab).toBe(false)
    })
})
