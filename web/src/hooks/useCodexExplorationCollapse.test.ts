import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_CODEX_EXPLORATION_COLLAPSED,
    getInitialCodexExplorationCollapsed,
    useCodexExplorationCollapse,
} from './useCodexExplorationCollapse'

const STORAGE_KEY = 'hapi-codex-exploration-collapsed'

describe('useCodexExplorationCollapse helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to collapsed', () => {
        expect(getInitialCodexExplorationCollapsed()).toBe(DEFAULT_CODEX_EXPLORATION_COLLAPSED)
    })

    it('reads valid stored values and ignores invalid values', () => {
        window.localStorage.setItem(STORAGE_KEY, 'false')
        expect(getInitialCodexExplorationCollapsed()).toBe(false)

        window.localStorage.setItem(STORAGE_KEY, 'invalid')
        expect(getInitialCodexExplorationCollapsed()).toBe(DEFAULT_CODEX_EXPLORATION_COLLAPSED)
    })
})

describe('useCodexExplorationCollapse', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('persists the expanded preference', () => {
        const { result } = renderHook(() => useCodexExplorationCollapse())

        act(() => {
            result.current.setCodexExplorationCollapsed(false)
        })

        expect(result.current.codexExplorationCollapsed).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false')
    })

    it('removes the stored preference when restored to the default', () => {
        window.localStorage.setItem(STORAGE_KEY, 'false')
        const { result } = renderHook(() => useCodexExplorationCollapse())

        act(() => {
            result.current.setCodexExplorationCollapsed(true)
        })

        expect(result.current.codexExplorationCollapsed).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('applies cross-tab changes from storage events', () => {
        const { result } = renderHook(() => useCodexExplorationCollapse())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: 'false',
            }))
        })

        expect(result.current.codexExplorationCollapsed).toBe(false)

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: null,
            }))
        })

        expect(result.current.codexExplorationCollapsed).toBe(true)
    })
})
