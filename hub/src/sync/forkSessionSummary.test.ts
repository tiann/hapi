import { describe, expect, it } from 'bun:test'
import { buildForkSessionSummary } from './forkSessionSummary'

describe('buildForkSessionSummary', () => {
    it('prefixes the manual title before the generated summary', () => {
        expect(buildForkSessionSummary({
            name: '  Manual title  ',
            summary: { text: 'Generated title' },
        }, 123)).toEqual({
            text: 'Fork: Manual title',
            updatedAt: 123,
        })
    })

    it('uses the generated summary when no manual title exists', () => {
        expect(buildForkSessionSummary({ summary: { text: 'Generated title' } }, 456)).toEqual({
            text: 'Fork: Generated title',
            updatedAt: 456,
        })
    })

    it('does not create a synthetic summary for an untitled source session', () => {
        expect(buildForkSessionSummary({ name: '  ', summary: { text: '   ' } }, 789)).toBeUndefined()
        expect(buildForkSessionSummary(undefined, 789)).toBeUndefined()
    })
})
