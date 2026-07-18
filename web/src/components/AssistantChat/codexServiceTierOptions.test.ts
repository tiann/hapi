import { describe, expect, it } from 'vitest'
import { getCodexComposerServiceTierOptions } from './codexServiceTierOptions'

describe('getCodexComposerServiceTierOptions', () => {
    it('returns the default Codex service tier presets', () => {
        expect(getCodexComposerServiceTierOptions()).toEqual([
            { value: null, label: 'Default' },
            { value: 'standard', label: 'Standard' },
            { value: 'fast', label: 'Fast' },
        ])
    })

    it('normalizes legacy priority service tier to Fast', () => {
        expect(getCodexComposerServiceTierOptions('priority')).toEqual([
            { value: null, label: 'Default' },
            { value: 'standard', label: 'Standard' },
            { value: 'fast', label: 'Fast' },
        ])
    })

    it('keeps an unknown current tier selectable', () => {
        expect(getCodexComposerServiceTierOptions('enterprise')).toEqual([
            { value: null, label: 'Default' },
            { value: 'standard', label: 'Standard' },
            { value: 'fast', label: 'Fast' },
            { value: 'enterprise', label: 'Enterprise' },
        ])
    })
})
