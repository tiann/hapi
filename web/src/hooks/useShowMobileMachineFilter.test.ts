import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SHOW_MOBILE_MACHINE_FILTER,
    useShowMobileMachineFilter,
} from './useShowMobileMachineFilter'

const STORAGE_KEY = 'hapi-show-mobile-machine-filter'

describe('useShowMobileMachineFilter', () => {
    beforeEach(() => window.localStorage.clear())

    it('defaults off and synchronizes preference changes in the same tab', () => {
        const first = renderHook(() => useShowMobileMachineFilter())
        const second = renderHook(() => useShowMobileMachineFilter())
        expect(first.result.current.showMobileMachineFilter).toBe(DEFAULT_SHOW_MOBILE_MACHINE_FILTER)

        act(() => first.result.current.setShowMobileMachineFilter(true))
        expect(first.result.current.showMobileMachineFilter).toBe(true)
        expect(second.result.current.showMobileMachineFilter).toBe(true)
        expect(localStorage.getItem(STORAGE_KEY)).toBe('true')

        act(() => second.result.current.setShowMobileMachineFilter(false))
        expect(first.result.current.showMobileMachineFilter).toBe(false)
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('synchronizes updates from another browsing context', () => {
        const { result } = renderHook(() => useShowMobileMachineFilter())
        act(() => window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'true' })))
        expect(result.current.showMobileMachineFilter).toBe(true)
    })
})
