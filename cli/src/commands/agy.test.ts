import { describe, expect, it } from 'vitest'
import { parseAgyCommandOptions } from './agy'

describe('parseAgyCommandOptions', () => {
    it('defaults AGY to remote (headless) mode', () => {
        expect(parseAgyCommandOptions([]).startingMode).toBe('remote')
    })

    it('accepts explicit remote mode', () => {
        expect(parseAgyCommandOptions(['--hapi-starting-mode', 'remote']).startingMode).toBe('remote')
    })

    it.each(['local', 'pty'])('rejects unsupported %s mode', (mode) => {
        expect(() => parseAgyCommandOptions(['--hapi-starting-mode', mode])).toThrow(
            'Invalid --hapi-starting-mode'
        )
    })
})
