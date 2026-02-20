import { describe, expect, it } from 'vitest'
import { validateDifftasticArgs, validateRipgrepArgs } from './argSecurity'

describe('argSecurity', () => {
    describe('validateRipgrepArgs', () => {
        it('allows safe ripgrep flags', () => {
            expect(validateRipgrepArgs(['--files'])).toEqual({ valid: true })
            expect(validateRipgrepArgs(['--iglob', '*.ts', '--files'])).toEqual({ valid: true })
        })

        it('rejects blocked exact flags', () => {
            expect(validateRipgrepArgs(['--pre', '/tmp/evil.sh', 'pattern'])).toEqual({
                valid: false,
                error: 'Blocked flag: --pre'
            })
            expect(validateRipgrepArgs(['--config', '/tmp/evil.toml'])).toEqual({
                valid: false,
                error: 'Blocked flag: --config'
            })
        })

        it('rejects blocked flags in key=value form', () => {
            expect(validateRipgrepArgs(['--pre=/tmp/evil.sh'])).toEqual({
                valid: false,
                error: 'Blocked flag: --pre'
            })
            expect(validateRipgrepArgs(['--type-add=foo:*.bar'])).toEqual({
                valid: false,
                error: 'Blocked flag: --type-add'
            })
        })
    })

    it('allows difftastic args (empty blocklist for now)', () => {
        expect(validateDifftasticArgs(['file1', 'file2'])).toEqual({ valid: true })
    })
})
