import { describe, expect, test } from 'bun:test'
import { AGY_EFFORT_LEVELS, getAgyModelChoices, splitAgyModelSelection } from './agyModels'

describe('splitAgyModelSelection', () => {
    test('separates native model variants including newer effort levels', () => {
        for (const effort of AGY_EFFORT_LEVELS) {
            expect(splitAgyModelSelection(`gemini-4-argon-${effort}`)).toEqual({ model: 'gemini-4-argon', effort })
        }
        expect(splitAgyModelSelection(' claude-opus-5-5-high ')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    })

    test('preserves base ids, thinking variants and custom model names', () => {
        for (const model of ['gemini-4-argon', 'claude-opus-4-6-thinking', 'custom-high', 'provider/custom-low']) {
            expect(splitAgyModelSelection(model)).toEqual({ model, effort: null })
        }
    })

    test('normalizes default selections to no explicit model', () => {
        for (const model of [null, undefined, '', '  ', 'auto', 'default']) {
            expect(splitAgyModelSelection(model)).toEqual({ model: null, effort: null })
        }
    })
})

describe('getAgyModelChoices', () => {
    test('groups available variants in catalog order and sorts only supported efforts', () => {
        expect(getAgyModelChoices([
            { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
            { modelId: 'claude-opus-5-5-max', name: 'Claude Opus 5.5 (Max)' },
            { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
            { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
            { modelId: 'claude-opus-5-5-xhigh', name: 'Claude Opus 5.5 (XHigh)' }
        ])).toEqual([
            { modelId: 'gemini-4-argon', name: 'Gemini 4 Argon', supportedEfforts: ['low', 'high'] },
            { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', supportedEfforts: ['xhigh', 'max'] }
        ])
    })

    test('keeps single variants, thinking models and custom models unchanged', () => {
        expect(getAgyModelChoices([
            { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
            { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
            { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
            { modelId: 'custom-high', name: 'Custom (High)' },
            { modelId: 'custom-low', name: 'Custom (Low)' }
        ])).toEqual([
            { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', supportedEfforts: [] },
            { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', supportedEfforts: [] },
            { modelId: 'custom-high', name: 'Custom (High)', supportedEfforts: [] },
            { modelId: 'custom-low', name: 'Custom (Low)', supportedEfforts: [] }
        ])
    })

    test('uses base ids as names when the catalog has no labels', () => {
        expect(getAgyModelChoices([
            { modelId: 'gemini-4-argon-medium' },
            { modelId: 'gemini-4-argon-high' },
            { modelId: 'custom' }
        ])).toEqual([
            { modelId: 'gemini-4-argon', name: 'gemini-4-argon', supportedEfforts: ['medium', 'high'] },
            { modelId: 'custom', name: 'custom', supportedEfforts: [] }
        ])
    })

    test('returns no choices for an empty catalog', () => {
        expect(getAgyModelChoices([])).toEqual([])
    })
})
