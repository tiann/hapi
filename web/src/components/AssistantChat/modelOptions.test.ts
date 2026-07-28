import { describe, expect, it } from 'vitest'
import { getModelOptionsForFlavor, getNextModelForFlavor } from './modelOptions'

describe('getModelOptionsForFlavor', () => {
    it('returns Gemini model options for gemini flavor', () => {
        const options = getModelOptionsForFlavor('gemini')
        expect(options[0]).toEqual({ value: null, label: 'Default' })
        expect(options.some((o) => o.value === 'gemini-3-flash-preview')).toBe(true)
        expect(options.some((o) => o.value === 'gemini-2.5-flash')).toBe(true)
    })

    it('returns Claude model options for claude flavor', () => {
        const options = getModelOptionsForFlavor('claude')
        expect(options[0]).toEqual({ value: null, label: 'Default' })
        expect(options.some((o) => o.value === 'sonnet')).toBe(true)
        expect(options.some((o) => o.value === 'opus')).toBe(true)
    })

    it('keeps Claude presets when explicit options only include Sonnet models', () => {
        const options = getModelOptionsForFlavor('claude', null, [
            { value: null, label: 'Default' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' }
        ])
        expect(options).toEqual([
            { value: null, label: 'Default' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' },
            { value: 'opus', label: 'Opus' },
            { value: 'opus[1m]', label: 'Opus 1M' },
            { value: 'fable', label: 'Fable' },
            { value: 'fable[1m]', label: 'Fable 1M' }
        ])
    })

    it('adds non-preset Claude options without hiding Opus presets', () => {
        const options = getModelOptionsForFlavor('claude', null, [
            { value: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' }
        ])
        expect(options).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' },
            { value: 'opus', label: 'Opus' },
            { value: 'opus[1m]', label: 'Opus 1M' },
            { value: 'fable', label: 'Fable' },
            { value: 'fable[1m]', label: 'Fable 1M' }
        ])
    })

    it('includes custom Gemini model from env/config in options', () => {
        const options = getModelOptionsForFlavor('gemini', 'gemini-custom-experiment')
        expect(options.some((o) => o.value === 'gemini-custom-experiment')).toBe(true)
    })

    it('does not duplicate a preset Gemini model', () => {
        const options = getModelOptionsForFlavor('gemini', 'gemini-2.5-flash')
        const flashCount = options.filter((o) => o.value === 'gemini-2.5-flash').length
        expect(flashCount).toBe(1)
    })

    it('includes the current custom model when it is missing from explicit options', () => {
        const options = getModelOptionsForFlavor('codex', 'gpt-legacy', [
            { value: 'gpt-5.5', label: 'GPT-5.5' }
        ])
        expect(options).toEqual([
            { value: 'gpt-legacy', label: 'gpt-legacy' },
            { value: 'gpt-5.5', label: 'GPT-5.5' }
        ])
    })

    it('returns only the supplied custom options for opencode flavor (no claude fallback)', () => {
        const options = getModelOptionsForFlavor('opencode', null, [
            { value: 'ollama/exaone:4.5-33b-q8', label: 'Ollama (SER8)/EXAONE 4.5 33B Q8' },
            { value: 'mlx/qwen3:0.6b', label: 'MLX/Qwen3 0.6B' }
        ])
        expect(options).toEqual([
            { value: 'ollama/exaone:4.5-33b-q8', label: 'Ollama (SER8)/EXAONE 4.5 33B Q8' },
            { value: 'mlx/qwen3:0.6b', label: 'MLX/Qwen3 0.6B' }
        ])
    })

    it('returns an empty list for opencode flavor before models are discovered (no claude fallback)', () => {
        const options = getModelOptionsForFlavor('opencode', null)
        expect(options).toEqual([])
    })

    it('returns only default/current for cursor before models are discovered (no claude fallback)', () => {
        const options = getModelOptionsForFlavor('cursor', 'composer-2.5')
        expect(options).toEqual([
            { value: null, label: 'Default' },
            { value: 'composer-2.5', label: 'composer-2.5' }
        ])
    })

    it('returns dynamic cursor options when supplied', () => {
        const options = getModelOptionsForFlavor('cursor', null, [
            { value: 'composer-2.5', label: 'Composer 2.5' },
            { value: 'gpt-5.5-high-fast', label: 'GPT-5.5 High Fast' }
        ])
        expect(options).toEqual([
            { value: 'composer-2.5', label: 'Composer 2.5' },
            { value: 'gpt-5.5-high-fast', label: 'GPT-5.5 High Fast' }
        ])
    })

    it('does not inject raw wire id when dual picker base is already listed', () => {
        const wire = 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]'
        const options = getModelOptionsForFlavor('cursor', wire, [
            { value: null, label: 'Default' },
            { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
            { value: 'composer-2.5', label: 'Composer 2.5' },
        ])
        expect(options).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
            { value: 'composer-2.5', label: 'Composer 2.5' },
        ])
    })

    it('injects unknown wire id only when catalog lacks base and wire', () => {
        const wire = 'claude-opus-4-9[effort=high,fast=false]'
        const options = getModelOptionsForFlavor('cursor', wire, [
            { value: null, label: 'Default' },
            { value: 'composer-2.5', label: 'Composer 2.5' },
        ])
        expect(options).toEqual([
            { value: null, label: 'Default' },
            { value: wire, label: wire },
            { value: 'composer-2.5', label: 'Composer 2.5' },
        ])
    })

    it('includes the current opencode model when it is missing from explicit options', () => {
        const options = getModelOptionsForFlavor('opencode', 'ollama/legacy', [
            { value: 'ollama/exaone:4.5-33b-q8', label: 'Ollama EXAONE' }
        ])
        expect(options).toEqual([
            { value: 'ollama/legacy', label: 'ollama/legacy' },
            { value: 'ollama/exaone:4.5-33b-q8', label: 'Ollama EXAONE' }
        ])
    })

    it('returns just the auto/default option for pi flavor (no Claude fallback)', () => {
        const options = getModelOptionsForFlavor('pi')
        expect(options).toEqual([{ value: null, label: 'Default' }])
    })

    it('keeps the current pi model in the options list when it is not auto', () => {
        const options = getModelOptionsForFlavor('pi', 'claude-sonnet-4-5')
        expect(options).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }
        ])
    })

    it('returns only default/current for grok without falling back to Claude models', () => {
        expect(getModelOptionsForFlavor('grok')).toEqual([
            { value: null, label: 'Default' }
        ])
        expect(getModelOptionsForFlavor('grok', 'grok-4.5')).toEqual([
            { value: null, label: 'Default' },
            { value: 'grok-4.5', label: 'grok-4.5' }
        ])
    })
})

describe('getNextModelForFlavor', () => {
    it('cycles Gemini models', () => {
        const next = getNextModelForFlavor('gemini', null)
        expect(next).not.toBeNull()
    })

    it('cycles Claude models', () => {
        const next = getNextModelForFlavor('claude', null)
        expect(next).not.toBeNull()
    })

    it('cycles through Claude presets when explicit options only include Sonnet models', () => {
        const next = getNextModelForFlavor('claude', 'sonnet[1m]', [
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' }
        ])
        expect(next).toBe('opus')
    })

    it('cycles explicit model options', () => {
        const next = getNextModelForFlavor('codex', 'gpt-5.5', [
            { value: 'gpt-5.5', label: 'GPT-5.5' },
            { value: 'gpt-5.4', label: 'GPT-5.4' }
        ])
        expect(next).toBe('gpt-5.4')
    })

    it('does not choose auto when cycling explicit Codex model options from an unknown current model', () => {
        const next = getNextModelForFlavor('codex', 'gpt-legacy', [
            { value: 'gpt-5.5', label: 'GPT-5.5' },
            { value: 'gpt-5.4', label: 'GPT-5.4' }
        ])
        expect(next).toBe('gpt-5.5')
    })

    it('keeps the current opencode model when the dynamic list has not loaded (undefined customOptions)', () => {
        const next = getNextModelForFlavor('opencode', 'ollama/exaone:4.5-33b-q8')
        expect(next).toBe('ollama/exaone:4.5-33b-q8')
    })

    it('keeps the current opencode model when the dynamic list is empty', () => {
        const next = getNextModelForFlavor('opencode', 'ollama/exaone:4.5-33b-q8', [])
        expect(next).toBe('ollama/exaone:4.5-33b-q8')
    })

    it('returns null for opencode without a current model and without dynamic options (no Claude fallback)', () => {
        const next = getNextModelForFlavor('opencode', null, [])
        expect(next).toBeNull()
    })

    it('keeps the current cursor model when the dynamic list has not loaded', () => {
        const next = getNextModelForFlavor('cursor', 'composer-2.5')
        expect(next).toBe('composer-2.5')
    })

    it('keeps the current pi model on cycle (no Claude fallback)', () => {
        // Pi has no predefined model list — Ctrl/Cmd+M must not cycle
        // through Claude presets, which would push sonnet/opus ids into
        // a Pi session via set-session-config.
        const next = getNextModelForFlavor('pi', 'claude-sonnet-4-5')
        expect(next).toBe('claude-sonnet-4-5')
    })

    it('keeps the current grok model on cycle (no Claude fallback)', () => {
        expect(getNextModelForFlavor('grok', 'grok-4.5')).toBe('grok-4.5')
    })

    it('returns null for pi without a current model (no Claude fallback)', () => {
        const next = getNextModelForFlavor('pi', null)
        expect(next).toBeNull()
    })

    it('treats "auto" as null and returns null for pi (no Claude preset injection)', () => {
        // normalizeCurrentModel maps 'auto' to null; a Pi session whose UI
        // displays 'Auto' must not be switched to sonnet/opus by the
        // cycler shortcut.
        const next = getNextModelForFlavor('pi', 'auto')
        expect(next).toBeNull()
    })

    it('treats "default" as null and returns null for pi', () => {
        const next = getNextModelForFlavor('pi', 'default')
        expect(next).toBeNull()
    })

    it('treats empty/whitespace strings as null for pi (no Claude preset injection)', () => {
        expect(getNextModelForFlavor('pi', '')).toBeNull()
        expect(getNextModelForFlavor('pi', '   ')).toBeNull()
    })

    it('trims surrounding whitespace from the current pi model', () => {
        const next = getNextModelForFlavor('pi', '  claude-sonnet-4-5  ')
        expect(next).toBe('claude-sonnet-4-5')
    })

    it('keeps a kimi current model on cycle (no Claude fallback)', () => {
        expect(getNextModelForFlavor('kimi', 'kimi-k2-0711')).toBe('kimi-k2-0711')
        expect(getNextModelForFlavor('kimi', null)).toBeNull()
    })

    it('keeps a cursor current model on cycle (no Claude fallback)', () => {
        expect(getNextModelForFlavor('cursor', 'composer-2.5')).toBe('composer-2.5')
        expect(getNextModelForFlavor('cursor', null)).toBeNull()
    })

    it('keeps an opencode current model on cycle (no Claude fallback)', () => {
        expect(getNextModelForFlavor('opencode', 'ollama/legacy')).toBe('ollama/legacy')
        expect(getNextModelForFlavor('opencode', null)).toBeNull()
    })
})

describe('getModelOptionsForFlavor — pi normalize filter', () => {
    it('drops "auto" and renders just the default option for pi', () => {
        // 'auto' should be normalized to null, which equals the auto entry;
        // we must not produce a duplicate { value: null, label: 'auto' } row.
        const options = getModelOptionsForFlavor('pi', 'auto')
        expect(options).toEqual([{ value: null, label: 'Default' }])
    })

    it('drops "default" and renders just the default option for pi', () => {
        const options = getModelOptionsForFlavor('pi', 'default')
        expect(options).toEqual([{ value: null, label: 'Default' }])
    })

    it('drops empty/whitespace currentModel for pi', () => {
        expect(getModelOptionsForFlavor('pi', '')).toEqual([{ value: null, label: 'Default' }])
        expect(getModelOptionsForFlavor('pi', '   ')).toEqual([{ value: null, label: 'Default' }])
    })

    it('trims whitespace from a real current pi model', () => {
        const options = getModelOptionsForFlavor('pi', '  custom-model  ')
        expect(options).toEqual([
            { value: null, label: 'Default' },
            { value: 'custom-model', label: 'custom-model' }
        ])
    })
})
