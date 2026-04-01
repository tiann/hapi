import { describe, expect, it } from 'vitest'
import { isRemoteTerminalSupported, isWindowsHostOs } from './terminalSupport'

describe('terminal support helpers', () => {
    it('detects Windows session hosts as unsupported', () => {
        expect(isWindowsHostOs('win32')).toBe(true)
        expect(isRemoteTerminalSupported({ os: 'win32', path: '', host: '' })).toBe(false)
    })

    it('keeps remote terminal enabled for non-Windows or unknown hosts', () => {
        expect(isWindowsHostOs('linux')).toBe(false)
        expect(isRemoteTerminalSupported({ os: 'linux', path: '', host: '' })).toBe(true)
        expect(isRemoteTerminalSupported(null)).toBe(true)
    })
})
