import { describe, it, expect } from 'bun:test'
import { appendUserTerminalOutput, getUserTerminalBuffer, clearUserTerminalBuffer } from './userTerminalBuffer'

describe('userTerminalBuffer', () => {
    it('stores and retrieves output per terminal', () => {
        appendUserTerminalOutput('s1', 't1', 'hello ')
        appendUserTerminalOutput('s1', 't1', 'world')
        expect(getUserTerminalBuffer('s1', 't1')).toBe('hello world')
    })

    it('keeps sessions isolated', () => {
        appendUserTerminalOutput('sa', 't1', 'alpha')
        appendUserTerminalOutput('sb', 't1', 'beta')
        expect(getUserTerminalBuffer('sa', 't1')).toBe('alpha')
        expect(getUserTerminalBuffer('sb', 't1')).toBe('beta')
    })

    it('keeps independent terminals of the same session isolated', () => {
        appendUserTerminalOutput('s2', 'tA', 'output-from-A')
        appendUserTerminalOutput('s2', 'tB', 'output-from-B')
        // Each terminal replays only its own output — never the other shell's.
        expect(getUserTerminalBuffer('s2', 'tA')).toBe('output-from-A')
        expect(getUserTerminalBuffer('s2', 'tB')).toBe('output-from-B')
    })

    it('clearing one terminal does not wipe a sibling terminal of the same session', () => {
        appendUserTerminalOutput('s6', 'tA', 'keep-A')
        appendUserTerminalOutput('s6', 'tB', 'keep-B')
        clearUserTerminalBuffer('s6', 'tA')
        expect(getUserTerminalBuffer('s6', 'tA')).toBe('')
        expect(getUserTerminalBuffer('s6', 'tB')).toBe('keep-B')
    })

    it('returns empty string for unknown terminal', () => {
        expect(getUserTerminalBuffer('nonexistent', 't1')).toBe('')
    })

    it('ignores empty data', () => {
        appendUserTerminalOutput('s3', 't1', 'keep')
        appendUserTerminalOutput('s3', 't1', '')
        expect(getUserTerminalBuffer('s3', 't1')).toBe('keep')
    })

    it('clears buffer on demand', () => {
        appendUserTerminalOutput('s4', 't1', 'data')
        clearUserTerminalBuffer('s4', 't1')
        expect(getUserTerminalBuffer('s4', 't1')).toBe('')
    })

    it('rolls over at max size', () => {
        const small = 'a'.repeat(100)
        // Fill buffer to near capacity
        for (let i = 0; i < 2600; i++) {
            appendUserTerminalOutput('s5', 't1', small)
        }
        const buf = getUserTerminalBuffer('s5', 't1')
        // Should be at most MAX_BUFFER_BYTES (256KB)
        const MAX = 256 * 1024
        expect(buf.length).toBeLessThanOrEqual(MAX)
        // Should contain the most recent data (tail preserved)
        expect(buf.endsWith(small)).toBe(true)
    })
})
