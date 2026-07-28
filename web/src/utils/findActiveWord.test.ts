import { describe, expect, it } from 'vitest'
import { findActiveWord } from './findActiveWord'

describe('findActiveWord', () => {
    it('does not let active words span newlines', () => {
        expect(findActiveWord('@foo\nbar', { start: 8, end: 8 }, ['@', '/'])).toBeUndefined()
        expect(findActiveWord('/help\nsome', { start: 10, end: 10 }, ['@', '/'])).toBeUndefined()
        // Cold-review regression: line-2 caret must not pull @ from line 1.
        expect(
            findActiveWord('@abc\ndef', { start: 8, end: 8 }, ['@', '/', '$'])
        ).toBeUndefined()
    })

    it('treats U+FFFC mention atoms as hard boundaries', () => {
        const afterChip = findActiveWord('\uFFFC@pee', { start: 5, end: 5 }, ['@', '/'])
        expect(afterChip?.activeWord).toBe('@pee')
        expect(afterChip?.offset).toBe(1)

        // Prefix before a chip must not swallow the atom when caret is after it.
        expect(
            findActiveWord('@foo\uFFFCbar', { start: 8, end: 8 }, ['@', '/'])
        ).toBeUndefined()
    })

    it('still finds @ after a space on the same line', () => {
        const hit = findActiveWord('see @peer', { start: 9, end: 9 }, ['@', '/'])
        expect(hit?.activeWord).toBe('@peer')
        expect(hit?.offset).toBe(4)
    })
})
