import { describe, expect, test } from 'bun:test'
import {
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_PRESETS,
    CLAUDE_MODEL_PRESETS,
    CLAUDE_MODEL_LABELS,
    CLAUDE_DEEPSEEK_MODEL_EFFORT_PRESETS,
    CLAUDE_DEEPSEEK_MODEL_LABELS,
    CLAUDE_DEEPSEEK_MODEL_PRESETS,
    DEFAULT_CLAUDE_DEEPSEEK_MODEL,
    CC_API_MODEL_EFFORT_PRESETS,
    CC_API_MODEL_LABELS,
    CC_API_MODEL_PRESETS,
    DEFAULT_CC_API_MODEL,
    ARK_MODEL_LABELS,
    ARK_MODEL_PRESETS,
    DEFAULT_AGY_MODEL,
    DEFAULT_HERMES_MOA_PRESET,
    AGY_MODEL_LABELS,
    AGY_MODEL_PRESETS,
    HERMES_MOA_PRESET_LABELS,
    HERMES_MOA_PRESETS,
    getArkModelLabel,
    getCcApiAutoEffortLabel,
    getCcApiModelEffortPresets,
    getCcApiModelLabel,
    getAgyModelLabel,
    getClaudeModelLabel,
    getClaudeDeepSeekModelEffortPresets,
    getClaudeDeepSeekModelLabel,
    getHermesMoaPresetLabel,
    isAgyModelPreset,
    isCcApiEffortAllowedForModel,
    isClaudeModelPreset,
    isClaudeDeepSeekEffortAllowedForModel,
    isClaudeDeepSeekModelPreset,
    isHermesMoaPreset,
    isKnownCcApiModel,
} from './models'

describe('isClaudeModelPreset', () => {
    test('accepts valid presets', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(isClaudeModelPreset(preset)).toBe(true)
        }
    })

    test('rejects unknown model string', () => {
        expect(isClaudeModelPreset('haiku-3-5')).toBe(false)
    })

    test('rejects null and undefined', () => {
        expect(isClaudeModelPreset(null)).toBe(false)
        expect(isClaudeModelPreset(undefined)).toBe(false)
    })
})

describe('getClaudeModelLabel', () => {
    test('returns label for known presets', () => {
        expect(getClaudeModelLabel('fable')).toBe('Fable 5 · 1M')
        expect(getClaudeModelLabel('opus')).toBe('Opus 4.8 · 1M')
        expect(getClaudeModelLabel('sonnet')).toBe('Sonnet 5 · 1M')
        expect(getClaudeModelLabel('haiku')).toBe('Haiku 4.5 · 200K')
    })

    test('trims whitespace before lookup', () => {
        expect(getClaudeModelLabel('  sonnet  ')).toBe('Sonnet 5 · 1M')
    })

    test('labels explicit Sonnet 5 model IDs as 1M context', () => {
        expect(getClaudeModelLabel('claude-sonnet-5')).toBe('Sonnet 5 · 1M')
        expect(getClaudeModelLabel('claude-sonnet-5[1m]')).toBe('Sonnet 5 · 1M')
    })

    test('returns null for unknown model', () => {
        expect(getClaudeModelLabel('haiku-3-5')).toBeNull()
    })

    test('returns null for empty/whitespace-only string', () => {
        expect(getClaudeModelLabel('')).toBeNull()
        expect(getClaudeModelLabel('   ')).toBeNull()
    })
})

describe('model constants consistency', () => {
    test('CC-deepseek exposes the two official 1M V4 models', () => {
        expect(CLAUDE_DEEPSEEK_MODEL_PRESETS).toEqual([
            'deepseek-v4-pro[1m]',
            'deepseek-v4-flash',
        ])
        expect(DEFAULT_CLAUDE_DEEPSEEK_MODEL).toBe('deepseek-v4-pro[1m]')
        expect(CLAUDE_DEEPSEEK_MODEL_LABELS).toEqual({
            'deepseek-v4-pro[1m]': 'DeepSeek V4 Pro · 1M',
            'deepseek-v4-flash': 'DeepSeek V4 Flash · 1M',
        })
        expect(getClaudeDeepSeekModelLabel('deepseek-v4-pro')).toBe('DeepSeek V4 Pro · 1M')
        expect(getClaudeDeepSeekModelLabel('deepseek-v4-flash[1m]')).toBe('DeepSeek V4 Flash · 1M')
        expect(isClaudeDeepSeekModelPreset('deepseek-v4-pro[1m]')).toBe(true)
        expect(isClaudeDeepSeekModelPreset('deepseek-v4-flash')).toBe(true)
        expect(isClaudeDeepSeekModelPreset('deepseek-chat')).toBe(false)
    })

    test('CC-deepseek exposes only official high and max reasoning efforts', () => {
        expect(CLAUDE_DEEPSEEK_MODEL_EFFORT_PRESETS).toEqual({
            'deepseek-v4-pro[1m]': ['high', 'max'],
            'deepseek-v4-flash': ['high', 'max'],
        })
        expect(getClaudeDeepSeekModelEffortPresets('deepseek-v4-pro[1m]')).toEqual(['high', 'max'])
        expect(getClaudeDeepSeekModelEffortPresets('deepseek-v4-flash')).toEqual(['high', 'max'])
        expect(isClaudeDeepSeekEffortAllowedForModel('deepseek-v4-pro[1m]', null)).toBe(true)
        expect(isClaudeDeepSeekEffortAllowedForModel('deepseek-v4-flash', 'high')).toBe(true)
        expect(isClaudeDeepSeekEffortAllowedForModel('deepseek-v4-flash', 'max')).toBe(true)
        expect(isClaudeDeepSeekEffortAllowedForModel('deepseek-v4-flash', 'medium')).toBe(false)
    })

    test('Claude model presets follow the Claude Code concise picker order', () => {
        expect(CLAUDE_MODEL_PRESETS).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    })

    test('every CLAUDE_MODEL_PRESET has a label', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(CLAUDE_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('every AGY_MODEL_PRESET has a label', () => {
        for (const preset of AGY_MODEL_PRESETS) {
            expect(AGY_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('Ark model presets follow the official Coding Plan terminal order', () => {
        expect(ARK_MODEL_PRESETS).toEqual([
            'doubao-seed-2.0-code',
            'deepseek-v4-pro',
            'deepseek-v4-flash',
            'glm-5.2',
            'glm-latest',
            'kimi-k2.7-code',
            'kimi-k2.6',
            'minimax-m3',
            'minimax-m2.7',
            'doubao-seed-2.0-pro',
            'doubao-seed-2.0-lite',
            'doubao-seed-code',
        ])
        expect(ARK_MODEL_PRESETS).not.toContain('auto')
    })

    test('every ARK_MODEL_PRESET has a label', () => {
        for (const preset of ARK_MODEL_PRESETS) {
            expect(ARK_MODEL_LABELS[preset]).toBeDefined()
        }
    })


    test('CC API model presets expose only the user-selected provider models', () => {
        expect(CC_API_MODEL_PRESETS).toEqual([
            'doubao-seed-2.1-pro',
            'minimax-m3',
            'glm-5.2[1m]',
            'kimi-k3',
        ])
        expect(DEFAULT_CC_API_MODEL).toBe('doubao-seed-2.1-pro')
    })

    test('every CC API model preset has a label and effort mapping', () => {
        for (const preset of CC_API_MODEL_PRESETS) {
            expect(CC_API_MODEL_LABELS[preset]).toBeDefined()
            expect(CC_API_MODEL_EFFORT_PRESETS[preset]).toBeDefined()
        }
    })

    test('recognizes current, aliased, and retired-compatible CC API models but not arbitrary values', () => {
        expect(isKnownCcApiModel('kimi-k3')).toBe(true)
        expect(isKnownCcApiModel('glm-5.2')).toBe(true)
        expect(isKnownCcApiModel('kimi-k2.7-code')).toBe(true)
        expect(isKnownCcApiModel('custom-cc-api-model')).toBe(false)
        expect(isKnownCcApiModel(null)).toBe(false)
    })



    test('Antigravity agy model presets mirror live agy CLI choices', () => {
        expect(AGY_MODEL_PRESETS).toEqual([
            'Gemini 3.5 Flash (Medium)',
            'Gemini 3.5 Flash (High)',
            'Gemini 3.5 Flash (Low)',
            'Gemini 3.1 Pro (Low)',
            'Gemini 3.1 Pro (High)',
            'Gemini 3 Flash',
        ])
        expect(DEFAULT_AGY_MODEL).toBe('Gemini 3.5 Flash (High)')
        expect(AGY_MODEL_PRESETS).not.toContain('auto')
    })

    test('DEFAULT_AGY_MODEL is a valid preset', () => {
        expect(AGY_MODEL_PRESETS).toContain(DEFAULT_AGY_MODEL)
    })

    test('Hermes MoA presets are explicit and future-extensible', () => {
        expect(HERMES_MOA_PRESETS).toEqual(['default', 'fable-5-1m-max', 'gpt-5.5-xhigh', 'gpt-5.6-sol-max'])
        expect(DEFAULT_HERMES_MOA_PRESET).toBe('default')
        for (const preset of HERMES_MOA_PRESETS) {
            expect(HERMES_MOA_PRESET_LABELS[preset]).toBeDefined()
        }
    })
})


describe('isAgyModelPreset', () => {
    test('accepts only live Antigravity agy labels', () => {
        expect(isAgyModelPreset('Gemini 3.5 Flash (High)')).toBe(true)
        expect(isAgyModelPreset(' Gemini 3.5 Flash (High) ')).toBe(true)
        expect(isAgyModelPreset('Gemini 3 Flash')).toBe(true)
        expect(isAgyModelPreset('Claude Opus 4.6 (Thinking)')).toBe(false)
        expect(isAgyModelPreset('GPT-OSS 120B (Medium)')).toBe(false)
        expect(isAgyModelPreset('not-a-live-agy-model')).toBe(false)
        expect(isAgyModelPreset(null)).toBe(false)
    })
})

describe('getAgyModelLabel', () => {
    test('returns label for known Antigravity agy models', () => {
        expect(getAgyModelLabel('Gemini 3.5 Flash (High)')).toBe('Gemini 3.5 Flash (High)')
        expect(getAgyModelLabel('Gemini 3 Flash')).toBe('Gemini 3 Flash')
    })

    test('returns null for unknown or empty model', () => {
        expect(getAgyModelLabel('not-a-live-agy-model')).toBeNull()
        expect(getAgyModelLabel('')).toBeNull()
    })
})

describe('Hermes MoA model presets', () => {
    test('accepts and labels selectable MoA aggregator presets', () => {
        expect(isHermesMoaPreset('default')).toBe(true)
        expect(isHermesMoaPreset(' default ')).toBe(true)
        expect(getHermesMoaPresetLabel('default')).toBe('Opus 4.8 · 1M · Max')
        expect(isHermesMoaPreset('fable-5-1m-max')).toBe(true)
        expect(getHermesMoaPresetLabel('fable-5-1m-max')).toBe('Fable 5 · 1M · Max')
        expect(isHermesMoaPreset('gpt-5.5-xhigh')).toBe(true)
        expect(getHermesMoaPresetLabel('gpt-5.5-xhigh')).toBe('GPT-5.5 · 272K · XHigh')
        expect(isHermesMoaPreset('gpt-5.6-sol-max')).toBe(true)
        expect(getHermesMoaPresetLabel('gpt-5.6-sol-max')).toBe('GPT-5.6 Sol · 372K · Max')
    })

    test('rejects unknown or empty MoA presets', () => {
        expect(isHermesMoaPreset('auto')).toBe(false)
        expect(isHermesMoaPreset('moa-experimental')).toBe(false)
        expect(isHermesMoaPreset(null)).toBe(false)
        expect(getHermesMoaPresetLabel('')).toBeNull()
    })
})

describe('getArkModelLabel', () => {
    test('returns label for known Ark Coding Plan models', () => {
        expect(getArkModelLabel('doubao-seed-2.0-code')).toBe('Doubao Seed 2.0 Code')
        expect(getArkModelLabel('deepseek-v4-pro')).toBe('DeepSeek V4 Pro · 1M')
        expect(getArkModelLabel('kimi-k2.7-code')).toBe('Kimi K2.7 Code · 256K')
    })

    test('trims whitespace before lookup', () => {
        expect(getArkModelLabel('  glm-5.2  ')).toBe('GLM 5.2 · 1M')
    })

    test('returns null for unknown or empty model', () => {
        expect(getArkModelLabel('unknown-model')).toBeNull()
        expect(getArkModelLabel('')).toBeNull()
        expect(getArkModelLabel('   ')).toBeNull()
    })
})


describe('getCcApiModelLabel', () => {
    test('returns label for known CC API models', () => {
        expect(getCcApiModelLabel('doubao-seed-2.1-pro')).toBe('Doubao Seed 2.1 Pro · 256K')
        expect(getCcApiModelLabel('minimax-m3')).toBe('MiniMax M3 · 512K')
        expect(getCcApiModelLabel('glm-5.2[1m]')).toBe('GLM 5.2 · 1M')
    })

    test('returns null for unknown or empty model', () => {
        expect(getCcApiModelLabel('unknown-model')).toBeNull()
        expect(getCcApiModelLabel('')).toBeNull()
    })
})

describe('CC API model-aware effort mapping', () => {
    test('limits GLM to high/max', () => {
        expect(getCcApiModelEffortPresets('glm-5.2[1m]')).toEqual(['high', 'max'])
        expect(getCcApiModelEffortPresets('glm-5.2')).toEqual(['high', 'max'])
        expect(isCcApiEffortAllowedForModel('glm-5.2[1m]', 'high')).toBe(true)
        expect(isCcApiEffortAllowedForModel('glm-5.2[1m]', 'max')).toBe(true)
        expect(isCcApiEffortAllowedForModel('glm-5.2[1m]', 'xhigh')).toBe(false)
    })

    test('limits Doubao to Claude-compatible verified reasoning efforts', () => {
        expect(getCcApiModelEffortPresets('doubao-seed-2.1-pro')).toEqual(['low', 'medium', 'high'])
        expect(isCcApiEffortAllowedForModel('doubao-seed-2.1-pro', 'low')).toBe(true)
        expect(isCcApiEffortAllowedForModel('doubao-seed-2.1-pro', 'medium')).toBe(true)
        expect(isCcApiEffortAllowedForModel('doubao-seed-2.1-pro', 'high')).toBe(true)
        expect(isCcApiEffortAllowedForModel('doubao-seed-2.1-pro', 'minimal')).toBe(false)
        expect(isCcApiEffortAllowedForModel('doubao-seed-2.1-pro', 'xhigh')).toBe(false)
        expect(isCcApiEffortAllowedForModel('doubao-seed-2.1-pro', null)).toBe(true)
    })

    test('exposes only the official max effort for Kimi K3', () => {
        expect(getCcApiModelEffortPresets('minimax-m3')).toEqual([])
        expect(getCcApiModelEffortPresets('kimi-k3')).toEqual(['max'])
        expect(isCcApiEffortAllowedForModel('minimax-m3', 'high')).toBe(false)
        expect(isCcApiEffortAllowedForModel('kimi-k3', 'high')).toBe(false)
        expect(isCcApiEffortAllowedForModel('kimi-k3', 'max')).toBe(true)
        expect(isCcApiEffortAllowedForModel('kimi-k3', null)).toBe(true)
        expect(getCcApiAutoEffortLabel('minimax-m3')).toBe('Auto (MiniMax default)')
        expect(getCcApiAutoEffortLabel('kimi-k3')).toBe('Auto (K3 default: Max)')
    })

    test('allows persisted effort only for an unlisted CC-api model when resume pass-through is explicit', () => {
        expect(isCcApiEffortAllowedForModel('custom-cc-api-model', 'high')).toBe(false)
        expect(isCcApiEffortAllowedForModel(
            'custom-cc-api-model',
            'high',
            { allowUnlistedModel: true }
        )).toBe(true)
        expect(isCcApiEffortAllowedForModel(
            'kimi-k2.7-code',
            'high',
            { allowUnlistedModel: true }
        )).toBe(false)
    })
})

describe('Claude effort constants', () => {
    test('matches Claude Code --effort flag values in order', () => {
        expect(CLAUDE_EFFORT_PRESETS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    })

    test('every effort preset has a label', () => {
        for (const effort of CLAUDE_EFFORT_PRESETS) {
            expect(CLAUDE_EFFORT_LABELS[effort]).toBeDefined()
        }
    })
})
