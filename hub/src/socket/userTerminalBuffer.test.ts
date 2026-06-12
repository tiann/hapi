import { describe, it, expect } from 'bun:test'
import { appendUserTerminalOutput, getUserTerminalBuffer, clearUserTerminalBuffer } from './userTerminalBuffer'

describe('userTerminalBuffer', () => {
    it('stores and retrieves output per session', () => {
        appendUserTerminalOutput('s1', 't1', 'hello ')
        appendUserTerminalOutput('s1', 't1', 'world')
        expect(getUserTerminalBuffer('s1')).toBe('hello world')
    })

    it('keeps sessions isolated', () => {
        appendUserTerminalOutput('sa', 't1', 'alpha')
        appendUserTerminalOutput('sb', 't1', 'beta')
        expect(getUserTerminalBuffer('sa')).toBe('alpha')
        expect(getUserTerminalBuffer('sb')).toBe('beta')
    })

    it('returns empty string for unknown session', () => {
        expect(getUserTerminalBuffer('nonexistent')).toBe('')
    })

    it('ignores empty data', () => {
        appendUserTerminalOutput('s3', 't1', 'keep')
        appendUserTerminalOutput('s3', 't1', '')
        expect(getUserTerminalBuffer('s3')).toBe('keep')
    })

    it('clears buffer on demand', () => {
        appendUserTerminalOutput('s4', 't1', 'data')
        clearUserTerminalBuffer('s4')
        expect(getUserTerminalBuffer('s4')).toBe('')
    })

    it('rolls over at max size', () => {
        const small = 'a'.repeat(100)
        // Fill buffer to near capacity
        for (let i = 0; i < 2600; i++) {
            appendUserTerminalOutput('s5', 't1', small)
        }
        const buf = getUserTerminalBuffer('s5')
        // Should be at most MAX_BUFFER_BYTES (256KB)
        const MAX = 256 * 1024
        expect(buf.length).toBeLessThanOrEqual(MAX)
        // Should contain the most recent data (tail preserved)
        expect(buf.endsWith(small)).toBe(true)
    })
})
