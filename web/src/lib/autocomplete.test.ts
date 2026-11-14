import { describe, expect, it } from 'vitest'
import {
    isSkillAutocompleteQuery,
    normalizeSkillAutocompleteQuery,
} from './autocomplete'

describe('skill autocomplete aliases', () => {
    it('recognizes dollar and yen prefixes', () => {
        expect(isSkillAutocompleteQuery('$')).toBe(true)
        expect(isSkillAutocompleteQuery('$browser')).toBe(true)
        expect(isSkillAutocompleteQuery('￥')).toBe(true)
        expect(isSkillAutocompleteQuery('￥browser')).toBe(true)
        expect(isSkillAutocompleteQuery('\u00A5')).toBe(true)
        expect(isSkillAutocompleteQuery('\u00A5browser')).toBe(true)
        expect(isSkillAutocompleteQuery('/help')).toBe(false)
    })

    it('normalizes yen signs to the canonical dollar syntax', () => {
        expect(normalizeSkillAutocompleteQuery('￥browser')).toBe('$browser')
        expect(normalizeSkillAutocompleteQuery('￥')).toBe('$')
        expect(normalizeSkillAutocompleteQuery('\u00A5browser')).toBe('$browser')
        expect(normalizeSkillAutocompleteQuery('\u00A5')).toBe('$')
        expect(normalizeSkillAutocompleteQuery('$browser')).toBe('$browser')
        expect(normalizeSkillAutocompleteQuery('/help')).toBe('/help')
    })
})
