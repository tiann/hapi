import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_TOOL_CARD_DISPLAY_MODE,
    getInitialToolCardDisplayMode,
    getToolCardDisplayModeOptions,
    getToolCardDisplayPresentation,
    useToolCardDisplayMode,
} from './useToolCardDisplayMode'

describe('useToolCardDisplayMode', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('offers grouped, compact, and detailed display modes', () => {
        expect(getToolCardDisplayModeOptions()).toEqual([
            { value: 'grouped', labelKey: 'settings.chat.toolCardDisplay.grouped' },
            { value: 'compact', labelKey: 'settings.chat.toolCardDisplay.compact' },
            { value: 'detailed', labelKey: 'settings.chat.toolCardDisplay.detailed' },
        ])
    })

    it('defaults to grouped and ignores invalid unified values', () => {
        expect(getInitialToolCardDisplayMode()).toBe(DEFAULT_TOOL_CARD_DISPLAY_MODE)
        window.localStorage.setItem('hapi-tool-card-display-mode', 'invalid')
        expect(getInitialToolCardDisplayMode()).toBe(DEFAULT_TOOL_CARD_DISPLAY_MODE)
    })

    it('maps legacy classified preferences into compact and detailed modes', () => {
        window.localStorage.setItem('hapi-tool-grouping-mode', 'classified')
        expect(getInitialToolCardDisplayMode()).toBe('compact')

        window.localStorage.setItem('hapi-terminal-tool-display-mode', 'detailed')
        expect(getInitialToolCardDisplayMode()).toBe('detailed')
    })

    it('preserves a legacy detailed preference when no grouping preference exists', () => {
        window.localStorage.setItem('hapi-terminal-tool-display-mode', 'detailed')
        expect(getInitialToolCardDisplayMode()).toBe('detailed')
    })

    it('keeps an explicitly stored legacy grouped preference grouped', () => {
        window.localStorage.setItem('hapi-tool-grouping-mode', 'grouped')
        window.localStorage.setItem('hapi-terminal-tool-display-mode', 'detailed')
        expect(getInitialToolCardDisplayMode()).toBe('grouped')
    })

    it('prefers a valid unified value over legacy settings', () => {
        window.localStorage.setItem('hapi-tool-card-display-mode', 'compact')
        window.localStorage.setItem('hapi-tool-grouping-mode', 'grouped')
        expect(getInitialToolCardDisplayMode()).toBe('compact')
    })

    it('maps each display mode to grouping and terminal presentation behavior', () => {
        expect(getToolCardDisplayPresentation('grouped')).toEqual({
            groupingMode: 'grouped',
            terminalToolDisplayMode: 'compact',
        })
        expect(getToolCardDisplayPresentation('compact')).toEqual({
            groupingMode: 'classified',
            terminalToolDisplayMode: 'compact',
        })
        expect(getToolCardDisplayPresentation('detailed')).toEqual({
            groupingMode: 'classified',
            terminalToolDisplayMode: 'detailed',
        })
    })

    it('syncs consumers and removes obsolete storage when the mode changes', () => {
        window.localStorage.setItem('hapi-tool-grouping-mode', 'classified')
        window.localStorage.setItem('hapi-terminal-tool-display-mode', 'compact')
        const first = renderHook(() => useToolCardDisplayMode())
        const second = renderHook(() => useToolCardDisplayMode())

        act(() => first.result.current.setToolCardDisplayMode('detailed'))

        expect(first.result.current.toolCardDisplayMode).toBe('detailed')
        expect(second.result.current.toolCardDisplayMode).toBe('detailed')
        expect(window.localStorage.getItem('hapi-tool-card-display-mode')).toBe('detailed')
        expect(window.localStorage.getItem('hapi-tool-grouping-mode')).toBeNull()
        expect(window.localStorage.getItem('hapi-terminal-tool-display-mode')).toBeNull()

        act(() => second.result.current.setToolCardDisplayMode('grouped'))

        expect(first.result.current.toolCardDisplayMode).toBe('grouped')
        expect(second.result.current.toolCardDisplayMode).toBe('grouped')
        expect(window.localStorage.getItem('hapi-tool-card-display-mode')).toBeNull()
    })

    it('keeps the selected mode when localStorage rejects a write', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage unavailable')
        })
        try {
            const first = renderHook(() => useToolCardDisplayMode())

            act(() => first.result.current.setToolCardDisplayMode('detailed'))

            expect(first.result.current.toolCardDisplayMode).toBe('detailed')
        } finally {
            setItem.mockRestore()
        }
    })
})
