import { describe, expect, it } from 'vitest'
import { insertComposerSnippet } from './composer-insertion'

describe('insertComposerSnippet', () => {
    it('inserts into an empty composer and places the cursor after the snippet', () => {
        expect(insertComposerSnippet('', { start: 0, end: 0 }, 'hello')).toEqual({
            text: 'hello',
            cursorPosition: 5
        })
    })

    it('replaces the selected range without adding separators', () => {
        expect(insertComposerSnippet('ask OLD now', { start: 4, end: 7 }, 'NEW')).toEqual({
            text: 'ask NEW now',
            cursorPosition: 7
        })
    })

    it('separates a snippet appended to existing text with a blank line', () => {
        expect(insertComposerSnippet('draft', { start: 5, end: 5 }, 'snippet')).toEqual({
            text: 'draft\n\nsnippet',
            cursorPosition: 14
        })
    })

    it('does not add an extra separator when the insertion point already touches whitespace', () => {
        expect(insertComposerSnippet('draft\n\n', { start: 7, end: 7 }, 'snippet')).toEqual({
            text: 'draft\n\nsnippet',
            cursorPosition: 14
        })
    })

    it('keeps the cursor immediately after the snippet when adding a trailing separator before following text', () => {
        expect(insertComposerSnippet('beforeafter', { start: 6, end: 6 }, ' snippet ')).toEqual({
            text: 'before\n\n snippet \n\nafter',
            cursorPosition: 17
        })
    })
})
