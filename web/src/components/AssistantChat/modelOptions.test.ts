import { describe, expect, it } from 'vitest'
import { getModelOptionsForFlavor, getNextModelForFlavor } from './modelOptions'

describe('getModelOptionsForFlavor', () => {
    it('returns Antigravity agy model options for agy flavor', () => {
        const options = getModelOptionsForFlavor('agy')
        expect(options[0]).toEqual({ value: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' })
        expect(options.some((o) => o.value === 'Gemini 3.5 Flash (High)')).toBe(true)
        expect(options.some((o) => o.value === 'Gemini 3 Flash')).toBe(true)
        expect(options.some((o) => o.value === 'GPT-OSS 120B (Medium)')).toBe(false)
        expect(options.some((o) => o.value === null)).toBe(false)
    })

    it('returns Claude model options for claude flavor', () => {
        const options = getModelOptionsForFlavor('claude')
        expect(options[0]).toEqual({ value: null, label: 'Default (Claude Code)' })
        expect(options.some((o) => o.value === 'fable')).toBe(true)
        expect(options.some((o) => o.value === 'opus')).toBe(true)
        expect(options.some((o) => o.value === 'sonnet')).toBe(true)
        expect(options.some((o) => o.value === 'haiku')).toBe(true)
    })

    it('returns and cycles the two official CC-deepseek 1M model options', () => {
        expect(getModelOptionsForFlavor('claude-deepseek')).toEqual([
            { value: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro · 1M' },
            { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · 1M' },
        ])
        expect(getNextModelForFlavor('claude-deepseek', 'deepseek-v4-pro[1m]')).toBe('deepseek-v4-flash')
        expect(getNextModelForFlavor('claude-deepseek', 'deepseek-v4-flash')).toBe('deepseek-v4-pro[1m]')
    })

    it('returns Codex GPT-5.6 model options with Auto as null for live sessions', () => {
        const options = getModelOptionsForFlavor('codex')
        expect(options.slice(0, 4)).toEqual([
            { value: null, label: 'Auto' },
            { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · 372K' },
            { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 372K' },
            { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 372K' },
        ])
        expect(options).toContainEqual({ value: 'gpt-5.5', label: 'GPT-5.5 · 272K' })
        expect(options).toContainEqual({ value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark · 128K' })
    })

    it('preserves custom Codex model values in live session model options', () => {
        const options = getModelOptionsForFlavor('codex', 'gpt-custom-preview')
        expect(options[1]).toEqual({ value: 'gpt-custom-preview', label: 'gpt-custom-preview' })
    })

    it('returns Ark Coding Plan model options for claude-ark flavor without Auto', () => {
        const options = getModelOptionsForFlavor('claude-ark')
        expect(options[0]).toEqual({
            value: 'doubao-seed-2.0-code',
            label: 'Doubao Seed 2.0 Code'
        })
        expect(options.some((o) => o.value === null)).toBe(false)
        expect(options.some((o) => o.value === 'deepseek-v4-pro')).toBe(true)
        expect(options.some((o) => o.value === 'kimi-k2.7-code')).toBe(true)
    })


    it('returns CC-api model options without Auto', () => {
        const options = getModelOptionsForFlavor('cc-api')
        expect(options[0]).toEqual({
            value: 'doubao-seed-2.1-pro',
            label: 'Doubao Seed 2.1 Pro · 256K'
        })
        expect(options.some((o) => o.value === null)).toBe(false)
        expect(options.some((o) => o.value === 'minimax-m3')).toBe(true)
        expect(options).toContainEqual({
            value: 'glm-5.2[1m]',
            label: 'GLM 5.2 · 1M'
        })
        expect(options).toContainEqual({ value: 'kimi-k3', label: 'Kimi K3 · 1M' })
    })

    it('returns Hermes MoA preset options without Auto', () => {
        const options = getModelOptionsForFlavor('hermes-moa')
        expect(options).toEqual([
            { value: 'default', label: 'Opus 4.8 · 1M · Max' },
            { value: 'fable-5-1m-max', label: 'Fable 5 · 1M · Max' },
            { value: 'gpt-5.5-xhigh', label: 'GPT-5.5 · 272K · XHigh' },
            { value: 'gpt-5.6-sol-max', label: 'GPT-5.6 Sol · 372K · Max' },
        ])
        expect(options.some((o) => o.value === null)).toBe(false)
    })

    it('does not include custom Antigravity agy model values', () => {
        const options = getModelOptionsForFlavor('agy', 'agy-custom-experiment')
        expect(options.some((o) => o.value === 'agy-custom-experiment')).toBe(false)
    })

    it('does not duplicate a preset Antigravity agy model', () => {
        const options = getModelOptionsForFlavor('agy', 'Gemini 3.5 Flash (High)')
        const flashCount = options.filter((o) => o.value === 'Gemini 3.5 Flash (High)').length
        expect(flashCount).toBe(1)
    })

    it('cycles CC-api models from the first preset', () => {
        expect(getNextModelForFlavor('cc-api', null)).toBe('doubao-seed-2.1-pro')
        expect(getNextModelForFlavor('cc-api', 'doubao-seed-2.1-pro')).toBe('minimax-m3')
    })

    it('cycles Hermes MoA presets from the default preset', () => {
        expect(getNextModelForFlavor('hermes-moa', null)).toBe('default')
        expect(getNextModelForFlavor('hermes-moa', 'default')).toBe('fable-5-1m-max')
        expect(getNextModelForFlavor('hermes-moa', 'fable-5-1m-max')).toBe('gpt-5.5-xhigh')
        expect(getNextModelForFlavor('hermes-moa', 'gpt-5.5-xhigh')).toBe('gpt-5.6-sol-max')
        expect(getNextModelForFlavor('hermes-moa', 'gpt-5.6-sol-max')).toBe('default')
    })
})

describe('getNextModelForFlavor', () => {
    it('cycles Antigravity agy models', () => {
        const next = getNextModelForFlavor('agy', null)
        expect(next).not.toBeNull()
    })

    it('cycles Claude models', () => {
        const next = getNextModelForFlavor('claude', null)
        expect(next).not.toBeNull()
    })

    it('cycles Codex models from Auto to GPT-5.6 Sol', () => {
        expect(getNextModelForFlavor('codex', null)).toBe('gpt-5.6-sol')
        expect(getNextModelForFlavor('codex', 'gpt-5.6-sol')).toBe('gpt-5.6-terra')
    })

    it('cycles dynamically discovered Grok models', () => {
        const models = [{ id: 'grok-a', name: 'Grok A' }, { id: 'grok-b', name: 'Grok B' }]
        expect(getNextModelForFlavor('grok', null, models)).toBe('grok-a')
        expect(getNextModelForFlavor('grok', 'grok-a', models)).toBe('grok-b')
    })

    it('cycles Ark Coding Plan models from the first preset', () => {
        expect(getNextModelForFlavor('claude-ark', null)).toBe('doubao-seed-2.0-code')
        expect(getNextModelForFlavor('claude-ark', 'doubao-seed-2.0-code')).toBe('deepseek-v4-pro')
    })
})
