import { describe, it, expect, vi, afterEach } from 'vitest'
import { restoreTerminalState } from './terminalState'

describe('restoreTerminalState', () => {
    const originalStdoutIsTTY = process.stdout.isTTY
    const originalStdinIsTTY = process.stdin.isTTY
    const originalSetRawMode = (process.stdin as unknown as { setRawMode?: (mode: boolean) => void }).setRawMode

    afterEach(() => {
        vi.restoreAllMocks()
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY })
        if (originalSetRawMode) {
            Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: originalSetRawMode })
        } else {
            delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode
        }
    })

    // Once the controlling terminal is gone (SIGHUP), the slave-side fd can
    // still read isTTY=true even though nothing reads these writes anymore —
    // write() against a dead tty can throw synchronously (not just emit an
    // async 'error'). restoreTerminalState() wraps the escape-sequence
    // writes in try/catch so a terminal-loss cleanup call never crashes the
    // process it is trying to shut down gracefully.
    it('does not throw when process.stdout.write() throws synchronously against a dead tty', () => {
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        vi.spyOn(process.stdout, 'write').mockImplementation(() => {
            throw Object.assign(new Error('write EIO'), { code: 'EIO' })
        })

        expect(() => restoreTerminalState()).not.toThrow()
    })

    it('still attempts to disable raw mode even when the stdout writes threw', () => {
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
        vi.spyOn(process.stdout, 'write').mockImplementation(() => {
            throw Object.assign(new Error('write EIO'), { code: 'EIO' })
        })
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
        const setRawModeSpy = vi.fn()
        Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawModeSpy })

        restoreTerminalState()

        expect(setRawModeSpy).toHaveBeenCalledWith(false)
    })
})
