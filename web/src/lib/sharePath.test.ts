import { describe, expect, it } from 'vitest'
import { shareTargetPathnameFromBase } from './sharePath'

describe('shareTargetPathnameFromBase', () => {
    it('returns /share for root base', () => {
        expect(shareTargetPathnameFromBase('/')).toBe('/share')
    })

    it('returns /repo/share for subpath base', () => {
        expect(shareTargetPathnameFromBase('/repo/')).toBe('/repo/share')
    })

    it('handles base without trailing slash', () => {
        expect(shareTargetPathnameFromBase('/repo')).toBe('/repo/share')
    })
})
