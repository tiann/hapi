import { describe, expect, test } from 'bun:test'
import {
    CLAUDE_MODEL_PRESETS,
    CLAUDE_MODEL_LABELS,
    DEFAULT_GEMINI_MODEL,
    GEMINI_MODEL_LABELS,
    GEMINI_MODEL_PRESETS,
    getClaudeEffortLevelsForModel,
    getClaudeModelChoices,
    getClaudeModelLabel,
    isClaudeModelPreset,
    resolveClaudeEffortForModel,
} from './models'
import type { ClaudeModelSummary } from './apiTypes'

describe('isClaudeModelPreset', () => {
    test('accepts valid presets', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(isClaudeModelPreset(preset)).toBe(true)
        }
    })

    test('rejects unknown model string', () => {
        expect(isClaudeModelPreset('haiku')).toBe(false)
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
    })

    test('trims whitespace before lookup', () => {
        expect(getClaudeModelLabel('  sonnet  ')).toBe('Sonnet')
    })

    test('returns null for unknown model', () => {
        expect(getClaudeModelLabel('haiku')).toBeNull()
    })

    test('returns null for empty/whitespace-only string', () => {
        expect(getClaudeModelLabel('')).toBeNull()
        expect(getClaudeModelLabel('   ')).toBeNull()
    })
})

describe('model constants consistency', () => {
    test('every CLAUDE_MODEL_PRESET has a label', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(CLAUDE_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('every GEMINI_MODEL_PRESET has a label', () => {
        for (const preset of GEMINI_MODEL_PRESETS) {
            expect(GEMINI_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('DEFAULT_GEMINI_MODEL is a valid preset', () => {
        expect(GEMINI_MODEL_PRESETS).toContain(DEFAULT_GEMINI_MODEL)
    })
})

const FULL = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH = ['low', 'medium', 'high', 'max']

// Shape of a subscription account's catalog: an alias per family, older
// versions under their full ids.
const SUBSCRIPTION_CATALOG: ClaudeModelSummary[] = [
    { value: 'default', displayName: 'Default (recommended)', effortLevels: FULL },
    { value: 'opus', displayName: 'Opus 5.5', effortLevels: FULL },
    { value: 'claude-fable-5-1', displayName: 'Fable 5.1', effortLevels: FULL },
    { value: 'sonnet', displayName: 'Sonnet 5', effortLevels: FULL },
    { value: 'haiku', displayName: 'Haiku 4.5', effortLevels: [] },
    { value: 'claude-opus-4-7', displayName: 'Opus 4.7', effortLevels: FULL },
    { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', effortLevels: NO_XHIGH },
]

describe('getClaudeModelChoices', () => {
    test('lists the CLI picker rows as they are, labelled with their display names', () => {
        expect(getClaudeModelChoices(SUBSCRIPTION_CATALOG)).toEqual([
            { value: 'opus', label: 'Opus 5.5' },
            { value: 'claude-fable-5-1', label: 'Fable 5.1' },
            { value: 'sonnet', label: 'Sonnet 5' },
            { value: 'haiku', label: 'Haiku 4.5' },
            { value: 'claude-opus-4-7', label: 'Opus 4.7' },
            { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        ])
    })

    test('leaves the default row to the caller, which stores it as no model', () => {
        const choices = getClaudeModelChoices(SUBSCRIPTION_CATALOG)
        expect(choices.some((choice) => choice.value === 'default')).toBe(false)
    })

    test('falls back to the value when the CLI gives no display name', () => {
        expect(getClaudeModelChoices([{ value: 'claude-custom' }])).toEqual([
            { value: 'claude-custom', label: 'claude-custom' },
        ])
    })
})

describe('getClaudeEffortLevelsForModel', () => {
    test('reads the default row for the session default', () => {
        expect(getClaudeEffortLevelsForModel(null, SUBSCRIPTION_CATALOG)).toEqual(FULL)
    })

    test('reads the listed row for an alias or a full id', () => {
        expect(getClaudeEffortLevelsForModel('haiku', SUBSCRIPTION_CATALOG)).toEqual([])
        expect(getClaudeEffortLevelsForModel('claude-sonnet-4-6', SUBSCRIPTION_CATALOG)).toEqual(NO_XHIGH)
    })

    test('is unknown for a model the catalog does not list, or without a catalog', () => {
        expect(getClaudeEffortLevelsForModel('claude-opus-4-1', SUBSCRIPTION_CATALOG)).toBeUndefined()
        expect(getClaudeEffortLevelsForModel('opus', null)).toBeUndefined()
    })
})

describe('resolveClaudeEffortForModel', () => {
    test('keeps an effort the next model supports', () => {
        expect(resolveClaudeEffortForModel('max', 'claude-sonnet-4-6', SUBSCRIPTION_CATALOG)).toBe('max')
    })

    test('clears an effort level the next model does not offer', () => {
        expect(resolveClaudeEffortForModel('xhigh', 'claude-sonnet-4-6', SUBSCRIPTION_CATALOG)).toBeNull()
    })

    test('clears any effort when the next model has no effort control', () => {
        expect(resolveClaudeEffortForModel('low', 'haiku', SUBSCRIPTION_CATALOG)).toBeNull()
    })

    test('keeps the effort when support is unknown', () => {
        expect(resolveClaudeEffortForModel('xhigh', 'claude-opus-4-1', SUBSCRIPTION_CATALOG)).toBe('xhigh')
        expect(resolveClaudeEffortForModel('xhigh', 'haiku', null)).toBe('xhigh')
    })

    test('leaves an unset effort unset', () => {
        expect(resolveClaudeEffortForModel(null, 'haiku', SUBSCRIPTION_CATALOG)).toBeNull()
    })
})
