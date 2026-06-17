import { describe, expect, it } from 'vitest'
import { codexModelAdvertisesFastTier, isFastServiceTier } from './codexFastMode'

// Mirrors the real Codex catalog: the Fast tier's id is 'priority' and its
// display name is 'Fast', so the CLI captures both as lowercased tokens
// (['priority','fast']). Models without Fast advertise no such token.
const models = [
    { id: 'gpt-5.5', isDefault: true, serviceTiers: ['priority', 'fast'] },
    { id: 'gpt-5.4-mini', isDefault: false, serviceTiers: [] },
    { id: 'o3', isDefault: false }
]

describe('codexModelAdvertisesFastTier', () => {
    it('is true when the active model advertises a fast tier (real id=priority, name=Fast)', () => {
        expect(codexModelAdvertisesFastTier('gpt-5.5', models)).toBe(true)
    })

    it('falls back to the catalog default model when session model is auto/null', () => {
        // default model (gpt-5.5) advertises fast
        expect(codexModelAdvertisesFastTier(null, models)).toBe(true)
        expect(codexModelAdvertisesFastTier(undefined, models)).toBe(true)
        expect(codexModelAdvertisesFastTier('  ', models)).toBe(true)
    })

    it('is false when the active model does not advertise a fast tier', () => {
        expect(codexModelAdvertisesFastTier('gpt-5.4-mini', models)).toBe(false)
        expect(codexModelAdvertisesFastTier('o3', models)).toBe(false)
    })

    it('is false when the model is unknown or the catalog is empty', () => {
        expect(codexModelAdvertisesFastTier('gpt-9', models)).toBe(false)
        expect(codexModelAdvertisesFastTier('gpt-5.5', [])).toBe(false)
    })

    it('matches fast tokens case-insensitively', () => {
        expect(codexModelAdvertisesFastTier('m', [{ id: 'm', isDefault: true, serviceTiers: ['Fast'] }])).toBe(true)
    })
})

describe('isFastServiceTier', () => {
    it('detects the fast tier regardless of casing/spacing', () => {
        expect(isFastServiceTier('fast')).toBe(true)
        expect(isFastServiceTier(' Fast ')).toBe(true)
    })

    it('treats null/standard as not fast', () => {
        expect(isFastServiceTier(null)).toBe(false)
        expect(isFastServiceTier(undefined)).toBe(false)
        expect(isFastServiceTier('standard')).toBe(false)
    })
})
