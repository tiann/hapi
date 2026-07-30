import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { persistQuotes, readQuotes, serializeQuotes, QUOTES_MAX, type Quote } from './quotes'

const q = (id: string, text: string): Quote => ({
    id, text, messageId: 'm1', createdAt: 0,
})

describe('serializeQuotes', () => {
    it('returns the body unchanged when there are no quotes', () => {
        expect(serializeQuotes([], 'hello')).toBe('hello')
    })

    it('single quote gets no number prefix', () => {
        expect(serializeQuotes([q('1', 'alpha')], 'why?')).toBe('> alpha\n\nwhy?')
    })

    it('two or more quotes get [N] markers', () => {
        const out = serializeQuotes([q('1', 'alpha'), q('2', 'beta')], 'why?')
        expect(out).toBe('> **[1]**\n> alpha\n\n> **[2]**\n> beta\n\nwhy?')
    })

    it('prefixes every line so fenced code stays valid', () => {
        const code = '```ts\nconst a = 1\n```'
        expect(serializeQuotes([q('1', code)], '')).toBe(
            '> ```ts\n> const a = 1\n> ```\n\n'
        )
    })

    it('preserves indentation inside quoted code', () => {
        expect(serializeQuotes([q('1', 'if (x) {\n    doIt()\n}')], '')).toBe(
            '> if (x) {\n>     doIt()\n> }\n\n'
        )
    })

    it('uses a bare > for blank lines so the blockquote stays contiguous', () => {
        expect(serializeQuotes([q('1', 'a\n\nb')], '')).toBe('> a\n>\n> b\n\n')
    })

    it('quoting text that already contains > does not break', () => {
        expect(serializeQuotes([q('1', '> nested')], '')).toBe('> > nested\n\n')
    })

    it('keeps a trailing separator when the body is empty', () => {
        expect(serializeQuotes([q('1', 'alpha')], '')).toBe('> alpha\n\n')
    })
})

describe('quote storage', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => localStorage.clear())

    it('returns an empty list for an unknown session', () => {
        expect(readQuotes('nope')).toEqual([])
    })

    it('round-trips through localStorage', () => {
        persistQuotes('s1', [q('1', 'alpha')])
        expect(readQuotes('s1').map((x) => x.text)).toEqual(['alpha'])
    })

    it('isolates sessions', () => {
        persistQuotes('s1', [q('1', 'alpha')])
        persistQuotes('s2', [q('2', 'beta')])
        expect(readQuotes('s1').map((x) => x.text)).toEqual(['alpha'])
        expect(readQuotes('s2').map((x) => x.text)).toEqual(['beta'])
    })

    it('survives corrupted storage without throwing', () => {
        localStorage.setItem('hapi.quotes.v1.s1', '{not json')
        expect(readQuotes('s1')).toEqual([])
    })

    it('drops rows that are missing required fields', () => {
        localStorage.setItem('hapi.quotes.v1.s1', JSON.stringify([
            { id: '1', text: 'ok', messageId: 'm1', createdAt: 0 },
            { id: '2' },
            null,
        ]))
        expect(readQuotes('s1').map((x) => x.id)).toEqual(['1'])
    })

    it('caps the stored list at QUOTES_MAX', () => {
        const many = Array.from({ length: QUOTES_MAX + 5 }, (_, i) => q(String(i), `t${i}`))
        persistQuotes('s1', many)
        expect(readQuotes('s1')).toHaveLength(QUOTES_MAX)
    })
})
