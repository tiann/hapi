import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_TERMINAL_FONT_SIZE,
    getInitialTerminalFontSize,
    getTerminalFontSizeOptions,
} from './useTerminalFontSize'

describe('useTerminalFontSize helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns the allowed raw px options', () => {
        const options = getTerminalFontSizeOptions()

        expect(options).toEqual([
            { value: 9, label: '9px' },
            { value: 11, label: '11px' },
            { value: 13, label: '13px' },
            { value: 15, label: '15px' },
            { value: 17, label: '17px' },
        ])
    })

    it('falls back to the default size for missing or invalid storage values', () => {
        expect(getInitialTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE)

        window.localStorage.setItem('hapi-terminal-font-size', 'not-a-number')
        expect(getInitialTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE)

        window.localStorage.setItem('hapi-terminal-font-size', '19')
        expect(getInitialTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE)
    })

    it('reads a valid stored terminal font size', () => {
        window.localStorage.setItem('hapi-terminal-font-size', '17')

        expect(getInitialTerminalFontSize()).toBe(17)
    })
})
