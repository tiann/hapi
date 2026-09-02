import { describe, expect, test } from 'bun:test'
import {
    CLAUDE_MODEL_FALLBACK_OPTIONS,
    resolveClaudeModelFamily,
    CLAUDE_MODEL_LABELS,
    DEFAULT_GEMINI_MODEL,
    GEMINI_MODEL_LABELS,
    GEMINI_MODEL_PRESETS,
    getClaudeModelLabel,
    isClaudeModelPreset,
} from './models'

describe('isClaudeModelPreset', () => {
    test('accepts every recognized alias key', () => {
        for (const preset of Object.keys(CLAUDE_MODEL_LABELS)) {
            expect(isClaudeModelPreset(preset)).toBe(true)
        }
    })

    // haiku is a recognized alias (role B) even though the live CLI catalog
    // only started advertising it recently -- list_models showed the CLI
    // already offers it, and existing/new sessions need it resolved.
    test('accepts haiku', () => {
        expect(isClaudeModelPreset('haiku')).toBe(true)
    })

    test('rejects unknown model string', () => {
        expect(isClaudeModelPreset('gpt-4')).toBe(false)
    })

    test('rejects null and undefined', () => {
        expect(isClaudeModelPreset(null)).toBe(false)
        expect(isClaudeModelPreset(undefined)).toBe(false)
    })
})

describe('getClaudeModelLabel', () => {
    test('returns label for known presets', () => {
        expect(getClaudeModelLabel('sonnet')).toBe('Sonnet')
        expect(getClaudeModelLabel('opus')).toBe('Opus')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
        expect(getClaudeModelLabel('haiku')).toBe('Haiku')
    })

    test('trims whitespace before lookup', () => {
        expect(getClaudeModelLabel('  sonnet  ')).toBe('Sonnet')
    })

    test('returns null for unknown model', () => {
        expect(getClaudeModelLabel('gpt-4')).toBeNull()
    })

    test('returns null for empty/whitespace-only string', () => {
        expect(getClaudeModelLabel('')).toBeNull()
        expect(getClaudeModelLabel('   ')).toBeNull()
    })
})

describe('CLAUDE_MODEL_FALLBACK_OPTIONS', () => {
    test('has no [1m] pairs -- one row per model family', () => {
        for (const option of CLAUDE_MODEL_FALLBACK_OPTIONS) {
            expect(option.value.endsWith('[1m]')).toBe(false)
        }
    })

    test('every fallback option value is a recognized alias (role B)', () => {
        for (const option of CLAUDE_MODEL_FALLBACK_OPTIONS) {
            expect(isClaudeModelPreset(option.value)).toBe(true)
        }
    })

    test('includes haiku', () => {
        expect(CLAUDE_MODEL_FALLBACK_OPTIONS.map((option) => option.value)).toContain('haiku')
    })

    test('sonnet/opus/fable carry the full effort level list', () => {
        for (const value of ['sonnet', 'opus', 'fable'] as const) {
            const option = CLAUDE_MODEL_FALLBACK_OPTIONS.find((entry) => entry.value === value)
            expect(option?.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        }
    })

    // haiku must be a confirmed-empty array, not undefined -- undefined
    // would mean "unknown", but we know (and hardcoded) that haiku doesn't
    // support --effort.
    test('haiku carries a confirmed-empty (not undefined) effort level list', () => {
        const haiku = CLAUDE_MODEL_FALLBACK_OPTIONS.find((entry) => entry.value === 'haiku')
        expect(haiku?.supportedEffortLevels).toEqual([])
        expect(haiku?.supportedEffortLevels).not.toBeUndefined()
    })
})

describe('model constants consistency', () => {
    test('every GEMINI_MODEL_PRESET has a label', () => {
        for (const preset of GEMINI_MODEL_PRESETS) {
            expect(GEMINI_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('DEFAULT_GEMINI_MODEL is a valid preset', () => {
        expect(GEMINI_MODEL_PRESETS).toContain(DEFAULT_GEMINI_MODEL)
    })
})

describe('resolveClaudeModelFamily', () => {
    test('reads the family from a current resolved id', () => {
        expect(resolveClaudeModelFamily('claude-sonnet-5')).toBe('sonnet')
        expect(resolveClaudeModelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
        expect(resolveClaudeModelFamily('claude-fable-5-1[1m]')).toBe('fable')
    })

    test('reads presets and legacy aliases', () => {
        expect(resolveClaudeModelFamily('opus')).toBe('opus')
        expect(resolveClaudeModelFamily('sonnet[1m]')).toBe('sonnet')
    })

    test('reads pre-4 ids, where the generation comes before the family', () => {
        // claude-<gen>-<family>-<date>, not claude-<family>-<gen>. Positional
        // slicing returned "3" for all of these and conflated them.
        expect(resolveClaudeModelFamily('claude-3-5-sonnet-20241022')).toBe('sonnet')
        expect(resolveClaudeModelFamily('claude-3-opus-20240229')).toBe('opus')
        expect(resolveClaudeModelFamily('claude-3-5-haiku-20241022')).toBe('haiku')
    })

    test('reads a vendor-prefixed id', () => {
        expect(resolveClaudeModelFamily('us.anthropic.claude-sonnet-5')).toBe('sonnet')
    })

    test('returns null when nothing names a known family', () => {
        expect(resolveClaudeModelFamily('claude-opusplan-1')).toBeNull()
        expect(resolveClaudeModelFamily('gpt-5.6-sol')).toBeNull()
        expect(resolveClaudeModelFamily('auto')).toBeNull()
        expect(resolveClaudeModelFamily('default')).toBeNull()
        expect(resolveClaudeModelFamily(null)).toBeNull()
    })
})
