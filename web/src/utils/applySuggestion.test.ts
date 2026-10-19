import { describe, expect, it } from 'vitest'
import { applySuggestion } from './applySuggestion'

describe('applySuggestion', () => {
    it('replaces a full-width yen skill query with canonical dollar syntax', () => {
        expect(applySuggestion('￥b', { start: 2, end: 2 }, '$browser')).toEqual({
            text: '$browser ',
            cursorPosition: 9,
        })
    })

    it('replaces a narrow yen skill query with canonical dollar syntax', () => {
        expect(applySuggestion('\u00A5b', { start: 2, end: 2 }, '$browser')).toEqual({
            text: '$browser ',
            cursorPosition: 9,
        })
    })
})
