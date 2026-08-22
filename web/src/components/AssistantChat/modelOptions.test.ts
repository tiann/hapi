import { describe, expect, it } from 'vitest'
import { getClaudeComposerModelOptions, resolveClaudeComposerWireValue } from './claudeModelOptions'
import { getModelOptionsForFlavor, getNextModelForFlavor } from './modelOptions'

describe('getModelOptionsForFlavor', () => {
    it('never offers the unsupported default reset in an active AGY session', () => {
        for (const currentModel of [null, 'auto']) {
            const options = getModelOptionsForFlavor('agy', currentModel)
            expect(options.length).toBeGreaterThan(0)
            expect(options.some((option) => option.value === null)).toBe(false)
        }

        const options = getModelOptionsForFlavor('agy', 'agy-custom-model')
        expect(options[0]).toEqual({ value: 'agy-custom-model', label: 'agy-custom-model' })
        expect(options.some((option) => option.value === null)).toBe(false)
    })

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

    // Claude's live catalog REPLACES the picker's options -- the same
    // customOptions idiom codex/grok/copilot already use, not the old
    // merge-onto-static-presets behavior. Unlike other flavors, claude does
    // NOT run a supplied catalog through the generic withCurrentModelOption()
    // pass: that helper only compares raw wire values and knows nothing about
    // resolvedModel, so a session storing a *resolved* SDK id would fail to
    // match the catalog's alias row and get a second, raw-labeled duplicate
    // spliced in -- undoing the exact resolvedModel dedup
    // getClaudeComposerModelOptions already did when the caller built the
    // array. So a supplied non-empty catalog is trusted and returned as-is;
    // the caller (SessionChat.tsx) is responsible for calling
    // getClaudeComposerModelOptions itself first to get a complete list.
    it('uses the supplied Claude catalog as-is (pure passthrough), does not re-derive it', () => {
        const catalog = [
            { value: null, label: 'Default (recommended)' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' }
        ]
        const options = getModelOptionsForFlavor('claude', 'sonnet', catalog)
        expect(options).toEqual(catalog)
        expect(options).toBe(catalog)
    })

    it('falls back to the static preset list (role A) when no live catalog is supplied', () => {
        expect(getModelOptionsForFlavor('claude', null, [])).toEqual(
            getModelOptionsForFlavor('claude', null)
        )
        const options = getModelOptionsForFlavor('claude', null, undefined)
        expect(options.some((option) => option.value?.endsWith('[1m]'))).toBe(false)
    })

    // Integration test through the real production path: SessionChat.tsx's
    // claudeModelOptions memo calls getClaudeComposerModelOptions directly
    // (not getModelOptionsForFlavor) to build customOptions, THEN
    // HappyComposer.tsx renders via getModelOptionsForFlavor. Exercising only
    // getClaudeComposerModelOptions in isolation (claudeModelOptions.test.ts)
    // would not have caught the bug where the generic customOptions branch
    // re-added a plain-labeled duplicate row on top of an already-deduped list.
    it('integration: building the catalog via getClaudeComposerModelOptions first (as SessionChat.tsx does) and passing it through getModelOptionsForFlavor does not reintroduce a resolvedModel duplicate', () => {
        const liveCatalog = [
            { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true },
            { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true },
            { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', supportsFastMode: false },
            { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportsFastMode: false }
        ]
        // A session storing the *resolved* SDK id rather than the wire alias.
        const sessionModel = 'claude-opus-5[1m]'

        const finalizedOptions = getClaudeComposerModelOptions(sessionModel, liveCatalog)
        const rendered = getModelOptionsForFlavor('claude', sessionModel, finalizedOptions)

        expect(rendered).toEqual(finalizedOptions)
        // The core regression this guards: exactly one row represents the
        // opus[1m] model (matched via resolvedModel), never a second raw
        // "claude-opus-5[1m]" row alongside "Opus (1M context)".
        expect(rendered.filter((option) => option.value === 'opus[1m]' || option.value === sessionModel)).toHaveLength(1)
        expect(rendered.some((option) => option.value === sessionModel)).toBe(false)
    })

    it('integration: a legacy alias the live catalog no longer advertises still surfaces as an explicit, friendly-labeled row', () => {
        const liveCatalog = [
            { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true },
            { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true },
            { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', supportsFastMode: false },
            { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportsFastMode: false }
        ]
        const sessionModel = 'sonnet[1m]'

        const finalizedOptions = getClaudeComposerModelOptions(sessionModel, liveCatalog)
        const rendered = getModelOptionsForFlavor('claude', sessionModel, finalizedOptions)

        expect(rendered).toEqual(finalizedOptions)
        expect(rendered.some((option) => option.value === 'sonnet[1m]' && option.label === 'Sonnet 1M')).toBe(true)
        expect(rendered.filter((option) => option.value === 'sonnet[1m]')).toHaveLength(1)
    })

    it('resolving the wire value first, as SessionChat.tsx does, keeps the picker selection visible and lets Ctrl/Cmd+M cycling advance instead of clearing the pin', () => {
        const liveCatalog = [
            { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true },
            { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true },
            { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', supportsFastMode: false },
            { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportsFastMode: false }
        ]
        // A resolved SDK id, as an existing session actually stores it.
        const storedSessionModel = 'claude-opus-5[1m]'

        // Mirrors SessionChat.tsx's claudeComposerModelValue memo -- the value
        // actually passed as HappyComposer's `model` prop.
        const resolvedModelValue = resolveClaudeComposerWireValue(storedSessionModel, liveCatalog)
        expect(resolvedModelValue).toBe('opus[1m]')

        // Mirrors SessionChat.tsx's claudeModelOptions memo.
        const finalizedOptions = getClaudeComposerModelOptions(storedSessionModel, liveCatalog)

        // (b) Selection display: HappyComposer's isSelected compares
        // `model === option.value` for claude -- the resolved value must
        // match a real row, or the picker shows nothing checked.
        expect(finalizedOptions.some((option) => option.value === resolvedModelValue)).toBe(true)

        // (a) Cycling: HappyComposer's Ctrl/Cmd+M calls getNextModelForFlavor
        // with that same resolved value (not the raw stored id) -- it must
        // advance to the next concrete model, not clear the pin to Default.
        const next = getNextModelForFlavor('claude', resolvedModelValue, finalizedOptions)
        expect(next).toBe('sonnet')

        // Contrast: cycling from the *unresolved* raw stored id (not present
        // as any row's value) still hits the "not found" branch -- the (a)
        // fallback fix (this file) keeps that branch from clearing the pin to
        // the null Default row, but it still just restarts at the first
        // concrete model rather than properly advancing from the current
        // position. This is why SessionChat.tsx resolving the wire value
        // *before* it reaches the composer (rather than relying on this
        // fallback alone) is the real fix, not just a safety net.
        const nextFromUnresolvedId = getNextModelForFlavor('claude', storedSessionModel, finalizedOptions)
        expect(nextFromUnresolvedId).not.toBeNull()
        expect(nextFromUnresolvedId).toBe('opus[1m]')
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
            { value: null, label: 'Auto' },
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
            { value: null, label: 'Auto' },
            { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
            { value: 'composer-2.5', label: 'Composer 2.5' },
        ])
        expect(options).toEqual([
            { value: null, label: 'Auto' },
            { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
            { value: 'composer-2.5', label: 'Composer 2.5' },
        ])
    })

    it('injects unknown wire id only when catalog lacks base and wire', () => {
        const wire = 'claude-opus-4-9[effort=high,fast=false]'
        const options = getModelOptionsForFlavor('cursor', wire, [
            { value: null, label: 'Auto' },
            { value: 'composer-2.5', label: 'Composer 2.5' },
        ])
        expect(options).toEqual([
            { value: null, label: 'Auto' },
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

    it('uses null for Copilot Auto with dynamic model options', () => {
        const options = getModelOptionsForFlavor('copilot', null, [
            { value: null, label: 'Auto' },
            { value: 'gpt-5.6', label: 'GPT-5.6' }
        ])

        expect(options).toEqual([
            { value: null, label: 'Auto' },
            { value: 'gpt-5.6', label: 'GPT-5.6' }
        ])
        expect(options.find((option) => option.value === null)?.label).toBe('Auto')
    })
})

describe('getNextModelForFlavor', () => {
    it('cycles AGY null, auto, and unknown current values only to concrete models', () => {
        const firstConcrete = getModelOptionsForFlavor('agy').find((option) => option.value !== null)?.value
        expect(firstConcrete).toBeTruthy()
        expect(getNextModelForFlavor('agy', null)).toBe(firstConcrete)
        expect(getNextModelForFlavor('agy', 'auto')).toBe(firstConcrete)
        expect(getNextModelForFlavor('agy', 'agy-custom-model')).toBe(firstConcrete)
    })

    it('cycles Gemini models', () => {
        const next = getNextModelForFlavor('gemini', null)
        expect(next).not.toBeNull()
    })

    it('cycles Claude models', () => {
        const next = getNextModelForFlavor('claude', null)
        expect(next).not.toBeNull()
    })

    it('cycles through a supplied Claude catalog by replacing (not merging onto) the static presets, wrapping through the guaranteed Default row', () => {
        const next = getNextModelForFlavor('claude', 'sonnet[1m]', [
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' }
        ])
        // The catalog IS the full options list (already contains the current
        // model), but the null "Default" row is always guaranteed even when
        // the supplied catalog omits it -- cycling from the last row wraps
        // to Default, not back to the first supplied row.
        expect(next).toBeNull()
    })

    it('Ctrl/Cmd+M cycling never posts a value the supplied Claude catalog would reject (plain wire strings only)', () => {
        // Regression guard for the class of bug the Pi/OpenCode comments in
        // this file warn about (cycler posting a value from the wrong
        // source/shape). Claude model values are always plain wire strings
        // (short aliases like "sonnet"/"opus[1m]", or a raw resolved id) --
        // unlike Pi (provider-qualified) there is no structured value that
        // could be malformed by generic cycling.
        const catalog = [
            { value: null, label: 'Default (recommended)' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' }
        ]
        for (const current of [null, 'sonnet', 'opus[1m]', 'haiku']) {
            const next = getNextModelForFlavor('claude', current, catalog)
            expect(catalog.some((option) => option.value === next)).toBe(true)
        }
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

    it('resets a Copilot model to null when cycling to Auto', () => {
        expect(getNextModelForFlavor('copilot', 'gpt-5.6', [
            { value: null, label: 'Auto' },
            { value: 'gpt-5.6', label: 'GPT-5.6' }
        ])).toBeNull()
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
