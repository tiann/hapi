import { describe, expect, it } from 'vitest'
import { codexModelAdvertisesFastTier, codexModelAdvertisesUltrafastTier, getDisplayedCodexServiceTier } from './codexFastMode'

describe('Ultrafast picker availability', () => {
    const models = [
        { id: 'gpt-6.2-sol', isDefault: true, serviceTiers: ['priority', 'ultrafast'] },
        { id: 'gpt-6.2-astra', isDefault: false, serviceTiers: ['priority'] },
        { id: 'gpt-6-astra', isDefault: false, serviceTiers: ['ultrafast'] },
    ]

    it('resolves the selected model and account default, not a global capability', () => {
        expect(codexModelAdvertisesUltrafastTier(null, models)).toBe(true)
        expect(codexModelAdvertisesUltrafastTier('gpt-6.2-sol', models)).toBe(true)
        expect(codexModelAdvertisesUltrafastTier('gpt-6.2-astra', models)).toBe(false)
        expect(codexModelAdvertisesUltrafastTier('gpt-6-astra', models)).toBe(true)
        expect(codexModelAdvertisesUltrafastTier('unknown', models)).toBe(false)
        expect(codexModelAdvertisesUltrafastTier('gpt-6.2-sol', [])).toBe(false)
    })

    it('shows the control for an Ultrafast-only catalog and preserves its selection', () => {
        expect(codexModelAdvertisesFastTier('gpt-6-astra', models)).toBe(false)
        expect(getDisplayedCodexServiceTier('ultrafast')).toBe('ultrafast')
        expect(getDisplayedCodexServiceTier('priority')).toBe('fast')
    })
})
