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

    it('recognizes the full-width yen sign at the same boundaries as $', () => {
        const atStart = findActiveWord('￥browser', { start: 8, end: 8 }, ['@', '/', '$', '￥'])
        expect(atStart?.activeWord).toBe('￥browser')
        expect(atStart?.offset).toBe(0)

        const afterSpace = findActiveWord('run ￥browser', { start: 12, end: 12 }, ['@', '/', '$', '￥'])
        expect(afterSpace?.activeWord).toBe('￥browser')
        expect(afterSpace?.offset).toBe(4)

        expect(findActiveWord('run￥browser', { start: 11, end: 11 }, ['@', '/', '$', '￥'])).toBeUndefined()
    })

    it('recognizes the narrow yen sign at the same boundaries as $', () => {
        const atStart = findActiveWord('\u00A5browser', { start: 8, end: 8 }, ['@', '/', '$', '￥', '\u00A5'])
        expect(atStart?.activeWord).toBe('\u00A5browser')
        expect(atStart?.offset).toBe(0)

        const afterSpace = findActiveWord('run \u00A5browser', { start: 12, end: 12 }, ['@', '/', '$', '￥', '\u00A5'])
        expect(afterSpace?.activeWord).toBe('\u00A5browser')
        expect(afterSpace?.offset).toBe(4)

        expect(findActiveWord('run\u00A5browser', { start: 11, end: 11 }, ['@', '/', '$', '￥', '\u00A5'])).toBeUndefined()
    })
})
