import { describe, expect, it } from 'vitest'
import { parseAgyCommandOptions } from './agy'

describe('parseAgyCommandOptions', () => {
    it('defaults AGY to PTY mode', () => {
        expect(parseAgyCommandOptions([]).startingMode).toBe('pty')
    })

    it.each(['local', 'remote'])('rejects unsupported %s mode', (mode) => {
        expect(() => parseAgyCommandOptions(['--hapi-starting-mode', mode])).toThrow(
            'Invalid --hapi-starting-mode'
        )
    })
})
