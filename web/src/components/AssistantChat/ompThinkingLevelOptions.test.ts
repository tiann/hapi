import { describe, it, expect } from 'vitest'
import {
    getOmpThinkingLevelOptions,
    getHighestOmpThinkingLevel,
} from './ompThinkingLevelOptions'

describe('getOmpThinkingLevelOptions', () => {
    it('offers all standard levels when efforts is absent (fallback)', () => {
        const opts = getOmpThinkingLevelOptions(null, undefined)
        const values = opts.map(o => o.value)
        expect(values).toContain('off')
        expect(values).toContain('minimal')
        expect(values).toContain('xhigh')
    })

    it('offers only off + the model efforts when efforts present', () => {
        const opts = getOmpThinkingLevelOptions(null, ['low', 'medium', 'high'])
        const values = opts.map(o => o.value)
        expect(values).toEqual(['off', 'low', 'medium', 'high'])
    })

    it('normalizes efforts to lowercase (OMP may return "High")', () => {
        // OCR round 2: efforts with non-lowercase casing must still match the
        // lowercase currentLevel and the lowercase standard labels.
        const opts = getOmpThinkingLevelOptions('high', ['High', 'Medium'])
        const values = opts.map(o => o.value)
        expect(values).toContain('high')
        expect(values).toContain('medium')
        // No duplicate 'high' from the non-standard-current-level branch.
        expect(values.filter(v => v === 'high')).toHaveLength(1)
    })

    it('normalizes currentLevel to lowercase before comparing', () => {
        const opts = getOmpThinkingLevelOptions('High', ['high', 'medium'])
        const values = opts.map(o => o.value)
        // 'High' normalizes to 'high' which IS in candidateLevels → no duplicate push.
        expect(values.filter(v => v === 'high')).toHaveLength(1)
    })

    it('keeps a non-standard current level at the top (not dropped, not duplicated)', () => {
        // OCR round 3 regression: seeding `seen` with currentLevel made standard
        // levels disappear. A standard current level must remain selectable.
        const opts = getOmpThinkingLevelOptions('high', ['low', 'high'])
        const values = opts.map(o => o.value)
        // 'high' is standard + in efforts → appears once, not dropped.
        expect(values).toContain('high')
        expect(values.filter(v => v === 'high')).toHaveLength(1)
    })

    it('includes a truly non-standard current level that is not in efforts', () => {
        const opts = getOmpThinkingLevelOptions('ultra', ['low', 'high'])
        const values = opts.map(o => o.value)
        expect(values[0]).toBe('ultra')
        // And still includes the candidate levels.
        expect(values).toContain('low')
        expect(values).toContain('high')
    })

    it('treats auto/default current level as null (uses model default, no extra option)', () => {
        const opts = getOmpThinkingLevelOptions('auto', ['low', 'high'])
        const values = opts.map(o => o.value)
        expect(values).not.toContain('auto')
        expect(values).not.toContain('default')
    })

    it('dedups off when efforts already contains off', () => {
        const opts = getOmpThinkingLevelOptions(null, ['off', 'high'])
        const values = opts.map(o => o.value)
        expect(values.filter(v => v === 'off')).toHaveLength(1)
    })

    it('offers off even when efforts is empty array', () => {
        const opts = getOmpThinkingLevelOptions(null, [])
        // Empty efforts → fallback to all standard levels (including off).
        expect(opts.map(o => o.value)).toContain('off')
        expect(opts.map(o => o.value)).toContain('xhigh')
    })
})

describe('getHighestOmpThinkingLevel', () => {
    it('returns the highest level in efforts', () => {
        expect(getHighestOmpThinkingLevel(['low', 'medium', 'high'])).toBe('high')
    })

    it('returns xhigh when efforts contains xhigh', () => {
        expect(getHighestOmpThinkingLevel(['low', 'xhigh'])).toBe('xhigh')
    })

    it('normalizes efforts casing (High → high)', () => {
        // OCR round 3: getHighestOmpThinkingLevel must lowercase efforts so
        // 'High' matches the lowercase PI_THINKING_LEVELS.
        expect(getHighestOmpThinkingLevel(['High', 'XHigh'])).toBe('xhigh')
    })

    it('falls back to the full standard set when efforts absent', () => {
        expect(getHighestOmpThinkingLevel(undefined)).toBe('max')
        expect(getHighestOmpThinkingLevel([])).toBe('max')
    })
})
