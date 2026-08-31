import { beforeEach, describe, expect, it } from 'vitest'
import {
    MAX_TEXT_CONTEXT_CHARACTER_THRESHOLD,
    MAX_TEXT_CONTEXT_LINE_THRESHOLD,
    MIN_TEXT_CONTEXT_CHARACTER_THRESHOLD,
    MIN_TEXT_CONTEXT_LINE_THRESHOLD,
    getInitialTextContextThresholds,
    normalizeTextContextCharacterThreshold,
    normalizeTextContextLineThreshold,
} from './useTextContextPreferences'

describe('text context threshold preferences', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('uses 3000 characters and 60 lines by default', () => {
        expect(getInitialTextContextThresholds()).toEqual({
            characterThreshold: 3_000,
            lineThreshold: 60,
        })
    })

    it('reads stored thresholds', () => {
        localStorage.setItem('hapi-text-context-character-threshold', '4500')
        localStorage.setItem('hapi-text-context-line-threshold', '90')

        expect(getInitialTextContextThresholds()).toEqual({
            characterThreshold: 4_500,
            lineThreshold: 90,
        })
    })

    it('clamps thresholds to supported integer ranges', () => {
        expect(normalizeTextContextCharacterThreshold(0))
            .toBe(MIN_TEXT_CONTEXT_CHARACTER_THRESHOLD)
        expect(normalizeTextContextCharacterThreshold(200_000))
            .toBe(MAX_TEXT_CONTEXT_CHARACTER_THRESHOLD)
        expect(normalizeTextContextLineThreshold(0))
            .toBe(MIN_TEXT_CONTEXT_LINE_THRESHOLD)
        expect(normalizeTextContextLineThreshold(2_000))
            .toBe(MAX_TEXT_CONTEXT_LINE_THRESHOLD)
    })
})
