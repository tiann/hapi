import { describe, expect, it } from 'vitest'
import { isLongMessage } from './longMessage'

describe('isLongMessage', () => {
    it.each(['a', '漢', '😀'])('uses a strict 5,000-character cutoff for %s', (character) => {
        expect(isLongMessage(character.repeat(5000))).toBe(false)
        expect(isLongMessage(character.repeat(5001))).toBe(true)
    })

    it('accepts short text with many lines', () => {
        expect(isLongMessage('log\n'.repeat(100))).toBe(false)
    })
})
