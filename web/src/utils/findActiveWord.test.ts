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

    it.each([' ', '\t', '\u00a0'])('does not include prose after a skill and %j', (separator) => {
        const token = 'Use $review'
        const draft = `${token}${separator}it`
        expect(findActiveWord(draft, { start: draft.length, end: draft.length }, ['@', '/', '$'])).toBeUndefined()
        expect(findActiveWord(draft, { start: token.length, end: token.length }, ['@', '/', '$'])?.word).toBe('$review')
    })

    it.each([' ', '\t', '\u00a0'])('finds a fresh skill after prose and %j', (separator) => {
        const draft = `$review it with${separator}$li`
        expect(findActiveWord(draft, { start: draft.length, end: draft.length }, ['@', '/', '$'])?.activeWord).toBe('$li')
    })

    it.each(['@Project active', '/review it', '/review\t$ops', '@team\u00a0$ops'])('preserves multiword queries for %s', (query) => {
        expect(findActiveWord(query, { start: query.length, end: query.length }, ['@', '/', '$'])?.activeWord).toBe(query)
    })

    it('ends a skill query at Chinese punctuation without changing skill qualifiers', () => {
        const token = '$plugin:review'
        const draft = `${token}，继续`
        expect(findActiveWord(draft, { start: token.length, end: token.length }, ['$'])?.word).toBe(token)
        expect(findActiveWord(draft, { start: draft.length, end: draft.length }, ['$'])).toBeUndefined()
    })

    it('does not replace a following explicit skill reference', () => {
        expect(findActiveWord('$rev$lint', { start: 4, end: 4 }, ['$'])?.word).toBe('$rev')
    })
})
