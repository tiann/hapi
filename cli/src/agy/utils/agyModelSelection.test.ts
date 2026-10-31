import { describe, expect, it } from 'vitest'
import { normalizeAgyModelSelection } from './agyModelSelection'

const catalog = [
    { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
    { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    { modelId: 'gemini-4-argon-xhigh', name: 'Gemini 4 Argon (Xhigh)' },
    { modelId: 'gemini-4-argon-max', name: 'Gemini 4 Argon (Max)' },
    { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
]

describe('normalizeAgyModelSelection', () => {
    it('normalizes a launch/resume variant and lets an explicit effort override its suffix', () => {
        expect(normalizeAgyModelSelection('gemini-4-argon-medium', 'high', catalog))
            .toEqual({ model: 'gemini-4-argon', effort: 'high' })
        expect(normalizeAgyModelSelection('gemini-4-argon-medium', undefined, catalog))
            .toEqual({ model: 'gemini-4-argon', effort: 'medium' })
    })

    it('distinguishes explicit default effort from an omitted effort', () => {
        expect(normalizeAgyModelSelection('gemini-4-argon-medium', null, catalog))
            .toEqual({ model: 'gemini-4-argon', effort: null })
    })

    it.each(['xhigh', 'max'])('accepts the native %s effort when the catalog offers it', (effort) => {
        expect(normalizeAgyModelSelection('gemini-4-argon', effort, catalog))
            .toEqual({ model: 'gemini-4-argon', effort })
    })

    it('rejects unsupported or invalid effort levels', () => {
        expect(() => normalizeAgyModelSelection('gemini-4-argon', 'low', catalog))
            .toThrow('does not support effort low')
        expect(() => normalizeAgyModelSelection(null, 'extreme', catalog))
            .toThrow('Invalid Antigravity effort')
    })

    it.each(['gpt-oss-120b-medium', 'claude-opus-4-6-thinking'])(
        'keeps fixed model %s intact and clears a stale effort', (model) => {
            expect(normalizeAgyModelSelection(model, 'high', catalog)).toEqual({ model, effort: null })
        },
    )

    it('preserves custom names without guessing that their suffix is an effort', () => {
        expect(normalizeAgyModelSelection('custom-high', 'medium', []))
            .toEqual({ model: 'custom-high', effort: 'medium' })
    })

    it('keeps an unknown native wire id when its configurable base is not in the catalog', () => {
        expect(normalizeAgyModelSelection('gemini-future-medium', undefined, []))
            .toEqual({ model: 'gemini-future-medium', effort: null })
        expect(() => normalizeAgyModelSelection('gemini-future-medium', 'high', []))
            .toThrow('refresh the Antigravity model catalog first')
        expect(() => normalizeAgyModelSelection('gemini-future-medium', null, []))
            .toThrow('refresh the Antigravity model catalog first')
    })

    it('supports an effort with the native default model', () => {
        expect(normalizeAgyModelSelection(undefined, 'high', catalog)).toEqual({ model: null, effort: 'high' })
    })
})
