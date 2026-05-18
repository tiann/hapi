import { describe, expect, it } from 'vitest'
import { isRemoteTerminalSupported, isWindowsHostOs } from './terminalSupport'

describe('terminal support helpers', () => {
    it('does not disable remote terminal only because the session host is Windows', () => {
        expect(isWindowsHostOs('win32')).toBe(true)
        expect(isRemoteTerminalSupported({ os: 'win32', path: '', host: '' })).toBe(true)
    })

    it('keeps remote terminal enabled for non-Windows or unknown hosts by default', () => {
        expect(isWindowsHostOs('linux')).toBe(false)
        expect(isRemoteTerminalSupported({ os: 'linux', path: '', host: '' })).toBe(true)
        expect(isRemoteTerminalSupported(null)).toBe(true)
    })

    it('respects explicit terminal capability metadata when present', () => {
        expect(isRemoteTerminalSupported({
            os: 'win32',
            path: '',
            host: '',
            capabilities: { terminal: false }
        })).toBe(false)
        expect(isRemoteTerminalSupported({
            os: 'win32',
            path: '',
            host: '',
            capabilities: { terminal: true }
        })).toBe(true)
    })
})
