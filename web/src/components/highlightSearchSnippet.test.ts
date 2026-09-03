import { describe, expect, it } from 'vitest'
import { highlightSearchSnippet } from './highlightSearchSnippet'

describe('highlightSearchSnippet', () => {
    it('wraps case-insensitive query matches without touching the rest', () => {
        const parts = highlightSearchSnippet('…check Quest docs on the Quest…', 'quest')
        expect(parts).toEqual([
            { type: 'text', value: '…check ' },
            { type: 'mark', value: 'Quest' },
            { type: 'text', value: ' docs on the ' },
            { type: 'mark', value: 'Quest' },
            { type: 'text', value: '…' },
        ])
    })

    it('returns plain text when the query is empty or missing from the snippet', () => {
        expect(highlightSearchSnippet('no hit here', '')).toEqual([
            { type: 'text', value: 'no hit here' },
        ])
        expect(highlightSearchSnippet('no hit here', 'quest')).toEqual([
            { type: 'text', value: 'no hit here' },
        ])
    })
})
