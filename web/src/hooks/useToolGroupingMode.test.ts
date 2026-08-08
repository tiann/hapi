import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_TOOL_GROUPING_MODE,
    getInitialToolGroupingMode,
    getToolGroupingModeOptions,
    useToolGroupingMode,
} from './useToolGroupingMode'

describe('useToolGroupingMode helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns grouped and classified options', () => {
        expect(getToolGroupingModeOptions()).toEqual([
            { value: 'grouped', labelKey: 'settings.chat.toolGrouping.grouped' },
            { value: 'classified', labelKey: 'settings.chat.toolGrouping.classified' },
        ])
    })

    it('defaults to grouped for missing or invalid values', () => {
        expect(getInitialToolGroupingMode()).toBe(DEFAULT_TOOL_GROUPING_MODE)
        window.localStorage.setItem('hapi-tool-grouping-mode', 'invalid')
        expect(getInitialToolGroupingMode()).toBe(DEFAULT_TOOL_GROUPING_MODE)
    })

    it('reads the classified preference', () => {
        window.localStorage.setItem('hapi-tool-grouping-mode', 'classified')
        expect(getInitialToolGroupingMode()).toBe('classified')
    })

    it('syncs changes between hook consumers in the same window', () => {
        const first = renderHook(() => useToolGroupingMode())
        const second = renderHook(() => useToolGroupingMode())

        act(() => first.result.current.setToolGroupingMode('classified'))

        expect(first.result.current.toolGroupingMode).toBe('classified')
        expect(second.result.current.toolGroupingMode).toBe('classified')

        act(() => second.result.current.setToolGroupingMode('grouped'))

        expect(first.result.current.toolGroupingMode).toBe('grouped')
        expect(second.result.current.toolGroupingMode).toBe('grouped')
    })
})
