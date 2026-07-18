import { AGY_MODEL_PRESETS, ARK_MODEL_PRESETS, CC_API_MODEL_PRESETS, CLAUDE_DEEPSEEK_MODEL_PRESETS, CLAUDE_MODEL_PRESETS, HERMES_MOA_PRESETS, getAgyModelLabel, getArkModelLabel, getCcApiModelLabel, getClaudeDeepSeekModelLabel, getClaudeModelLabel, getHermesMoaPresetLabel } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import { CLAUDE_EFFORT_OPTIONS, CODEX_REASONING_EFFORT_OPTIONS, CODEX_SERVICE_TIER_OPTIONS, MODEL_OPTIONS, getCodexReasoningEffortOptionsForModel, isCodexReasoningEffortAllowedForModel } from './types'

describe('Claude model options', () => {
    it('matches the concise local Claude Code model menu', () => {
        expect(MODEL_OPTIONS.claude).toEqual([
            { value: 'auto', label: 'Default (Claude Code)' },
            { value: 'fable', label: 'Fable 5 · 1M' },
            { value: 'opus', label: 'Opus 4.8 · 1M' },
            { value: 'sonnet', label: 'Sonnet 5 · 1M' },
            { value: 'haiku', label: 'Haiku 4.5 · 200K' },
        ])
    })

    it('exposes friendly labels for Claude model presets', () => {
        expect(CLAUDE_MODEL_PRESETS).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
        expect(getClaudeModelLabel('fable')).toBe('Fable 5 · 1M')
        expect(getClaudeModelLabel('opus')).toBe('Opus 4.8 · 1M')
        expect(getClaudeModelLabel('sonnet')).toBe('Sonnet 5 · 1M')
        expect(getClaudeModelLabel('haiku')).toBe('Haiku 4.5 · 200K')
    })
})

describe('CC-ark model options', () => {
    it('matches the official Ark Coding Plan model menu without Auto', () => {
        expect(MODEL_OPTIONS['claude-ark']).toEqual(ARK_MODEL_PRESETS.map(model => ({
            value: model,
            label: getArkModelLabel(model) ?? model,
        })))
        expect(MODEL_OPTIONS['claude-ark'].map(option => option.value)).not.toContain('auto')
        expect(MODEL_OPTIONS['claude-ark'][0]).toEqual({
            value: 'doubao-seed-2.0-code',
            label: 'Doubao Seed 2.0 Code'
        })
    })
})

describe('CC-deepseek model options', () => {
    it('matches the official DeepSeek V4 1M menu without Auto', () => {
        expect(MODEL_OPTIONS['claude-deepseek']).toEqual(CLAUDE_DEEPSEEK_MODEL_PRESETS.map(model => ({
            value: model,
            label: getClaudeDeepSeekModelLabel(model) ?? model,
        })))
        expect(MODEL_OPTIONS['claude-deepseek']).toEqual([
            { value: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro · 1M' },
            { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · 1M' },
        ])
    })
})


describe('CC-api model options', () => {
    it('matches the local API router model menu without Auto', () => {
        expect(MODEL_OPTIONS['cc-api']).toEqual(CC_API_MODEL_PRESETS.map(model => ({
            value: model,
            label: getCcApiModelLabel(model) ?? model,
        })))
        expect(MODEL_OPTIONS['cc-api'].map(option => option.value)).not.toContain('auto')
        expect(MODEL_OPTIONS['cc-api'][0]).toEqual({
            value: 'doubao-seed-2.1-pro',
            label: 'Doubao Seed 2.1 Pro · 256K'
        })
        expect(MODEL_OPTIONS['cc-api']).toContainEqual({
            value: 'glm-5.2[1m]',
            label: 'GLM 5.2 · 1M'
        })
    })
})


describe('Antigravity agy model options', () => {
    it('matches the live agy CLI model menu without Auto', () => {
        expect(MODEL_OPTIONS.agy).toEqual(AGY_MODEL_PRESETS.map(model => ({
            value: model,
            label: getAgyModelLabel(model) ?? model,
        })))
        expect(MODEL_OPTIONS.agy.map(option => option.value)).not.toContain('auto')
        expect(MODEL_OPTIONS.agy[0]).toEqual({
            value: 'Gemini 3.5 Flash (Medium)',
            label: 'Gemini 3.5 Flash (Medium)'
        })
        expect(MODEL_OPTIONS.agy).toContainEqual({
            value: 'Gemini 3.5 Flash (High)',
            label: 'Gemini 3.5 Flash (High)'
        })
    })
})

describe('Hermes MoA model options', () => {
    it('matches the explicit Hermes MoA preset menu without Auto', () => {
        expect(MODEL_OPTIONS['hermes-moa']).toEqual(HERMES_MOA_PRESETS.map(model => ({
            value: model,
            label: getHermesMoaPresetLabel(model) ?? model,
        })))
        expect(MODEL_OPTIONS['hermes-moa'].map(option => option.value)).not.toContain('auto')
        expect(MODEL_OPTIONS['hermes-moa']).toEqual([
            { value: 'default', label: 'Opus 4.8 · 1M · Max' },
            { value: 'fable-5-1m-max', label: 'Fable 5 · 1M · Max' },
            { value: 'gpt-5.5-xhigh', label: 'GPT-5.5 · 272K · XHigh' },
            { value: 'gpt-5.6-sol-max', label: 'GPT-5.6 Sol · 372K · Max' },
        ])
    })
})

describe('Claude effort options', () => {
    it('matches supported effort presets in expected order', () => {
        expect(CLAUDE_EFFORT_OPTIONS).toEqual([
            { value: 'auto', label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
        ])
    })
})

describe('Codex model options', () => {
    it('includes the GPT-5.6 family in the expected order', () => {
        expect(MODEL_OPTIONS.codex).toEqual([
            { value: 'auto', label: 'Auto' },
            { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · 372K' },
            { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 372K' },
            { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 372K' },
            { value: 'gpt-5.5', label: 'GPT-5.5 · 272K' },
            { value: 'gpt-5.4', label: 'GPT-5.4 · 272K' },
            { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini · 272K' },
            { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark · 128K' },
        ])
    })
})

describe('Codex reasoning effort options', () => {
    it('matches Auto-model conservative reasoning levels in expected order', () => {
        expect(CODEX_REASONING_EFFORT_OPTIONS).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
        ])
    })

    it('matches GPT-5.6 Sol/Terra reasoning levels from the live Codex catalog', () => {
        expect(getCodexReasoningEffortOptionsForModel('gpt-5.6-sol')).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
            { value: 'ultra', label: 'Ultra' },
        ])
        expect(getCodexReasoningEffortOptionsForModel('gpt-5.6-terra')).toEqual(getCodexReasoningEffortOptionsForModel('gpt-5.6-sol'))
    })

    it('keeps GPT-5.6 Luna below Ultra because the live Codex catalog does not list Ultra', () => {
        expect(getCodexReasoningEffortOptionsForModel('gpt-5.6-luna')).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
        ])
        expect(isCodexReasoningEffortAllowedForModel('gpt-5.6-luna', 'ultra')).toBe(false)
    })

    it('matches GPT-5.5/GPT-5.4 locally effective reasoning levels', () => {
        expect(getCodexReasoningEffortOptionsForModel('gpt-5.5')).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
        ])
        expect(getCodexReasoningEffortOptionsForModel('gpt-5.4')).toEqual(getCodexReasoningEffortOptionsForModel('gpt-5.5'))
        expect(getCodexReasoningEffortOptionsForModel('gpt-5.4-mini')).toEqual(getCodexReasoningEffortOptionsForModel('gpt-5.5'))
        expect(isCodexReasoningEffortAllowedForModel('gpt-5.5', 'minimal')).toBe(false)
        expect(isCodexReasoningEffortAllowedForModel('gpt-5.5', 'max')).toBe(false)
    })

    it('matches GPT-5.3 Codex Spark reasoning levels from the live Codex catalog', () => {
        expect(getCodexReasoningEffortOptionsForModel('gpt-5.3-codex-spark')).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
        ])
        expect(isCodexReasoningEffortAllowedForModel('gpt-5.3-codex-spark', 'none')).toBe(false)
    })
})

describe('Codex service tier options', () => {
    it('matches supported service tiers in expected order', () => {
        expect(CODEX_SERVICE_TIER_OPTIONS).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'standard', label: 'Standard' },
            { value: 'fast', label: 'Fast' },
        ])
    })
})
