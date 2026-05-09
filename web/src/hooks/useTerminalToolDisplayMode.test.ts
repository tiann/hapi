import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_TERMINAL_TOOL_DISPLAY_MODE,
    getInitialTerminalToolDisplayMode,
    getTerminalToolDisplayModeOptions,
} from './useTerminalToolDisplayMode'

describe('useTerminalToolDisplayMode helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns the allowed terminal tool display options', () => {
        expect(getTerminalToolDisplayModeOptions()).toEqual([
            { value: 'compact', labelKey: 'settings.chat.terminalToolDisplay.compact' },
            { value: 'detailed', labelKey: 'settings.chat.terminalToolDisplay.detailed' },
        ])
    })

    it('falls back to the default display mode for missing or invalid storage values', () => {
        expect(getInitialTerminalToolDisplayMode()).toBe(DEFAULT_TERMINAL_TOOL_DISPLAY_MODE)

        window.localStorage.setItem('hapi-terminal-tool-display-mode', 'invalid')
        expect(getInitialTerminalToolDisplayMode()).toBe(DEFAULT_TERMINAL_TOOL_DISPLAY_MODE)
    })

    it('reads a valid stored terminal tool display mode', () => {
        window.localStorage.setItem('hapi-terminal-tool-display-mode', 'detailed')

        expect(getInitialTerminalToolDisplayMode()).toBe('detailed')
    })
})
