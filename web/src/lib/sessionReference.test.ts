import { describe, expect, it } from 'vitest'
import { buildSessionReferencePath, buildSessionReferenceText } from './sessionReference'

describe('buildSessionReferencePath', () => {
    it('builds a relative session path', () => {
        expect(buildSessionReferencePath('abc-def')).toBe('/sessions/abc-def')
    })

    it('encodes special characters in session ids', () => {
        expect(buildSessionReferencePath('a/b c')).toBe('/sessions/a%2Fb%20c')
    })
})

describe('buildSessionReferenceText', () => {
    it('includes a citation prompt with title and relative path', () => {
        expect(buildSessionReferenceText('upstream issue/pr discovery', 'abc-def')).toBe(
            'See session "upstream issue/pr discovery" (/sessions/abc-def) for context'
        )
    })
})
