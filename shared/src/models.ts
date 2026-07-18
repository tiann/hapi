export const DEFAULT_CLAUDE_MODEL_LABEL = 'Default (Claude Code)'

export const CLAUDE_MODEL_LABELS = {
    fable: 'Fable 5 · 1M',
    'fable[1m]': 'Fable 5 · 1M',
    'claude-fable-5': 'Fable 5 · 1M',
    'claude-fable-5[1m]': 'Fable 5 · 1M',
    // Verified against Anthropic docs and Claude Code 2.1.198 on 2026-07-02:
    // the `sonnet` alias resolves to Claude Sonnet 5, which always uses 1M context.
    sonnet: 'Sonnet 5 · 1M',
    'sonnet[1m]': 'Sonnet 5 · 1M',
    'claude-sonnet-5': 'Sonnet 5 · 1M',
    'claude-sonnet-5[1m]': 'Sonnet 5 · 1M',
    'claude-sonnet-4-6': 'Sonnet 4.6 · 200K',
    'claude-sonnet-4-6[1m]': 'Sonnet 4.6 · 1M',
    haiku: 'Haiku 4.5 · 200K',
    'claude-haiku-4-5': 'Haiku 4.5 · 200K',
    opus: 'Opus 4.8 · 1M',
    'opus[1m]': 'Opus 4.8 · 1M',
    'claude-opus-4-8': 'Opus 4.8 · 1M',
    'claude-opus-4-8[1m]': 'Opus 4.8 · 1M'
} as const

export const CLAUDE_MODEL_PRESETS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type ClaudeModelPreset = typeof CLAUDE_MODEL_PRESETS[number]
const CLAUDE_MODEL_PRESET_SET = new Set<string>(CLAUDE_MODEL_PRESETS)

export const CLAUDE_EFFORT_PRESETS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffortPreset = typeof CLAUDE_EFFORT_PRESETS[number]

export const CLAUDE_EFFORT_LABELS: Record<ClaudeEffortPreset, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max'
}

// DeepSeek's official Claude Code integration uses the explicit 1M Pro alias
// and the bare Flash model (1M is the service default for both V4 models).
export const CLAUDE_DEEPSEEK_MODEL_PRESETS = [
    'deepseek-v4-pro[1m]',
    'deepseek-v4-flash',
] as const
export type ClaudeDeepSeekModelPreset = typeof CLAUDE_DEEPSEEK_MODEL_PRESETS[number]
const CLAUDE_DEEPSEEK_MODEL_PRESET_SET = new Set<string>(CLAUDE_DEEPSEEK_MODEL_PRESETS)
export const DEFAULT_CLAUDE_DEEPSEEK_MODEL: ClaudeDeepSeekModelPreset = CLAUDE_DEEPSEEK_MODEL_PRESETS[0]

export const CLAUDE_DEEPSEEK_MODEL_LABELS: Record<ClaudeDeepSeekModelPreset, string> = {
    'deepseek-v4-pro[1m]': 'DeepSeek V4 Pro · 1M',
    'deepseek-v4-flash': 'DeepSeek V4 Flash · 1M',
}
const CLAUDE_DEEPSEEK_MODEL_LABEL_LOOKUP: Record<string, string> = {
    ...CLAUDE_DEEPSEEK_MODEL_LABELS,
    'deepseek-v4-pro': CLAUDE_DEEPSEEK_MODEL_LABELS['deepseek-v4-pro[1m]'],
    'deepseek-v4-flash[1m]': CLAUDE_DEEPSEEK_MODEL_LABELS['deepseek-v4-flash'],
}

// Official DeepSeek V4 thinking effort values. Compatibility aliases are not
// shown because low/medium collapse to high and xhigh collapses to max.
export const CLAUDE_DEEPSEEK_MODEL_EFFORT_PRESETS: Record<ClaudeDeepSeekModelPreset, readonly ClaudeEffortPreset[]> = {
    'deepseek-v4-pro[1m]': ['high', 'max'],
    'deepseek-v4-flash': ['high', 'max'],
}
const CLAUDE_DEEPSEEK_MODEL_EFFORT_LOOKUP: Record<string, readonly ClaudeEffortPreset[]> = {
    ...CLAUDE_DEEPSEEK_MODEL_EFFORT_PRESETS,
    'deepseek-v4-pro': CLAUDE_DEEPSEEK_MODEL_EFFORT_PRESETS['deepseek-v4-pro[1m]'],
    'deepseek-v4-flash[1m]': CLAUDE_DEEPSEEK_MODEL_EFFORT_PRESETS['deepseek-v4-flash'],
}

// Volcengine Ark Coding Plan for Claude Code, verified from official docs on 2026-06-18.
// Model Name does not support Auto in local terminal configuration; keep a concrete default.
// Source: https://www.volcengine.com/docs/82379/1928262?lang=zh
export const ARK_MODEL_PRESETS = [
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
] as const
export type ArkModelPreset = typeof ARK_MODEL_PRESETS[number]
export const DEFAULT_ARK_MODEL: ArkModelPreset = ARK_MODEL_PRESETS[0]

export const ARK_MODEL_LABELS: Record<ArkModelPreset, string> = {
    'doubao-seed-2.0-code': 'Doubao Seed 2.0 Code',
    'deepseek-v4-pro': 'DeepSeek V4 Pro · 1M',
    'deepseek-v4-flash': 'DeepSeek V4 Flash · 1M',
    'glm-5.2': 'GLM 5.2 · 1M',
    'glm-latest': 'GLM Latest',
    'kimi-k2.7-code': 'Kimi K2.7 Code · 256K',
    'kimi-k2.6': 'Kimi K2.6 · 256K',
    'minimax-m3': 'MiniMax M3 · 512K',
    'minimax-m2.7': 'MiniMax M2.7 · 200K',
    'doubao-seed-2.0-pro': 'Doubao Seed 2.0 Pro',
    'doubao-seed-2.0-lite': 'Doubao Seed 2.0 Lite',
    'doubao-seed-code': 'Doubao Seed Code',
}

export const AGY_MODEL_PRESETS = [
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)',
    'Gemini 3 Flash',
] as const
export type AgyModelPreset = typeof AGY_MODEL_PRESETS[number]
const AGY_MODEL_PRESET_SET = new Set<string>(AGY_MODEL_PRESETS)
export const DEFAULT_AGY_MODEL: AgyModelPreset = 'Gemini 3.5 Flash (High)'

export const AGY_MODEL_LABELS: Record<AgyModelPreset, string> = {
    'Gemini 3.5 Flash (Medium)': 'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (High)': 'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Low)': 'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (Low)': 'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)': 'Gemini 3.1 Pro (High)',
    'Gemini 3 Flash': 'Gemini 3 Flash',
}

export const HERMES_MOA_PRESETS = ['default', 'fable-5-1m-max', 'gpt-5.5-xhigh', 'gpt-5.6-sol-max'] as const
export type HermesMoaPreset = typeof HERMES_MOA_PRESETS[number]
const HERMES_MOA_PRESET_SET = new Set<string>(HERMES_MOA_PRESETS)
export const DEFAULT_HERMES_MOA_PRESET: HermesMoaPreset = 'default'

export const HERMES_MOA_PRESET_LABELS: Record<HermesMoaPreset, string> = {
    default: 'Opus 4.8 · 1M · Max',
    'fable-5-1m-max': 'Fable 5 · 1M · Max',
    'gpt-5.5-xhigh': 'GPT-5.5 · 272K · XHigh',
    'gpt-5.6-sol-max': 'GPT-5.6 Sol · 372K · Max',
}

// Local Claude Code API router (`claude-api` / HAPI `cc-api`).
// Keep this separate from ARK_MODEL_PRESETS so Ark Coding Plan remains untouched.
export const CC_API_MODEL_PRESETS = [
    'doubao-seed-2.1-pro',
    'minimax-m3',
    'glm-5.2[1m]',
    'kimi-k3',
] as const
export type CcApiModelPreset = typeof CC_API_MODEL_PRESETS[number]
export const DEFAULT_CC_API_MODEL: CcApiModelPreset = CC_API_MODEL_PRESETS[0]

export const CC_API_MODEL_LABELS: Record<CcApiModelPreset, string> = {
    'doubao-seed-2.1-pro': 'Doubao Seed 2.1 Pro · 256K',
    // MiniMax's general API model list says MiniMax-M3 is 1,000,000 tokens, but
    // its Claude Code integration docs currently set auto-compact to 512,000.
    // Label the effective Claude Code path rather than overstating the UI.
    'minimax-m3': 'MiniMax M3 · 512K',
    'glm-5.2[1m]': 'GLM 5.2 · 1M',
    // Moonshot's live /v1/models metadata reports context_length=1,048,576.
    'kimi-k3': 'Kimi K3 · 1M',
}
const CC_API_MODEL_LABEL_LOOKUP: Record<string, string> = {
    ...CC_API_MODEL_LABELS,
    // Backward-compatible label for older sessions created before the explicit
    // 1M Claude Code suffix was added.
    'glm-5.2': CC_API_MODEL_LABELS['glm-5.2[1m]'],
}

export const CC_API_MODEL_EFFORT_PRESETS: Record<CcApiModelPreset, readonly ClaudeEffortPreset[]> = {
    // Volcengine Doubao supports reasoning.effort minimal/low/medium/high, but
    // Claude CLI ignores "minimal"; expose the verified Claude-compatible levels.
    'doubao-seed-2.1-pro': ['low', 'medium', 'high'],
    // MiniMax M3 manages thinking adaptively; do not expose fake Claude-style levels.
    'minimax-m3': [],
    // Z.ai documents high/max thinking mapping for Claude Code.
    'glm-5.2[1m]': ['high', 'max'],
    // Kimi K3 always reasons; Moonshot currently exposes only reasoning_effort=max.
    'kimi-k3': ['max'],
}
const CC_API_MODEL_EFFORT_LOOKUP: Record<string, readonly ClaudeEffortPreset[]> = {
    ...CC_API_MODEL_EFFORT_PRESETS,
    'glm-5.2': CC_API_MODEL_EFFORT_PRESETS['glm-5.2[1m]'],
    // Retired from the picker, but keep its verified fixed-thinking semantics
    // so a persisted legacy session cannot gain arbitrary effort pass-through.
    'kimi-k2.7-code': [],
}

export const CC_API_AUTO_EFFORT_LABELS: Record<CcApiModelPreset, string> = {
    'doubao-seed-2.1-pro': 'Auto (Doubao default)',
    'minimax-m3': 'Auto (MiniMax default)',
    'glm-5.2[1m]': 'Auto',
    'kimi-k3': 'Auto (K3 default: Max)',
}
const CC_API_AUTO_EFFORT_LABEL_LOOKUP: Record<string, string> = {
    ...CC_API_AUTO_EFFORT_LABELS,
    'glm-5.2': CC_API_AUTO_EFFORT_LABELS['glm-5.2[1m]'],
}

export function isClaudeModelPreset(model: string | null | undefined): model is ClaudeModelPreset {
    return typeof model === 'string' && CLAUDE_MODEL_PRESET_SET.has(model)
}

export function getClaudeModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return CLAUDE_MODEL_LABELS[trimmedModel as keyof typeof CLAUDE_MODEL_LABELS] ?? null
}

export function isClaudeDeepSeekModelPreset(model: string | null | undefined): model is ClaudeDeepSeekModelPreset {
    return typeof model === 'string' && CLAUDE_DEEPSEEK_MODEL_PRESET_SET.has(model.trim())
}

export function getClaudeDeepSeekModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return CLAUDE_DEEPSEEK_MODEL_LABEL_LOOKUP[trimmedModel] ?? null
}

export function getClaudeDeepSeekModelEffortPresets(model?: string | null): readonly ClaudeEffortPreset[] {
    const trimmedModel = model?.trim()
    if (!trimmedModel) {
        return CLAUDE_DEEPSEEK_MODEL_EFFORT_PRESETS[DEFAULT_CLAUDE_DEEPSEEK_MODEL]
    }

    return CLAUDE_DEEPSEEK_MODEL_EFFORT_LOOKUP[trimmedModel] ?? []
}

export function isClaudeDeepSeekEffortAllowedForModel(model: string | null | undefined, effort: string | null | undefined): boolean {
    const normalizedEffort = effort?.trim().toLowerCase()
    if (!normalizedEffort || normalizedEffort === 'auto' || normalizedEffort === 'default') {
        return true
    }

    return getClaudeDeepSeekModelEffortPresets(model).includes(normalizedEffort as ClaudeEffortPreset)
}

export function getArkModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return ARK_MODEL_LABELS[trimmedModel as ArkModelPreset] ?? null
}

export function getCcApiModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return CC_API_MODEL_LABEL_LOOKUP[trimmedModel] ?? null
}

export function isKnownCcApiModel(model: string | null | undefined): boolean {
    const trimmedModel = model?.trim()
    return Boolean(trimmedModel && CC_API_MODEL_EFFORT_LOOKUP[trimmedModel] !== undefined)
}

export function isAgyModelPreset(model: string | null | undefined): model is AgyModelPreset {
    return typeof model === 'string' && AGY_MODEL_PRESET_SET.has(model.trim())
}

export function getAgyModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return AGY_MODEL_LABELS[trimmedModel as AgyModelPreset] ?? null
}

export function isHermesMoaPreset(model: string | null | undefined): model is HermesMoaPreset {
    return typeof model === 'string' && HERMES_MOA_PRESET_SET.has(model.trim())
}

export function getHermesMoaPresetLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return HERMES_MOA_PRESET_LABELS[trimmedModel as HermesMoaPreset] ?? null
}

export function getCcApiAutoEffortLabel(model?: string | null): string {
    const trimmedModel = model?.trim()
    if (!trimmedModel) {
        return 'Auto'
    }

    return CC_API_AUTO_EFFORT_LABEL_LOOKUP[trimmedModel] ?? 'Auto'
}

export function getCcApiModelEffortPresets(model?: string | null): readonly ClaudeEffortPreset[] {
    const trimmedModel = model?.trim()
    if (!trimmedModel) {
        return CC_API_MODEL_EFFORT_PRESETS[DEFAULT_CC_API_MODEL]
    }

    return CC_API_MODEL_EFFORT_LOOKUP[trimmedModel] ?? []
}

export function isCcApiEffortAllowedForModel(
    model: string | null | undefined,
    effort: string | null | undefined,
    options?: { allowUnlistedModel?: boolean }
): boolean {
    const normalizedEffort = effort?.trim().toLowerCase()
    if (!normalizedEffort || normalizedEffort === 'auto' || normalizedEffort === 'default') {
        return true
    }

    const trimmedModel = model?.trim()
    const effectiveModel = trimmedModel || DEFAULT_CC_API_MODEL
    const presets = CC_API_MODEL_EFFORT_LOOKUP[effectiveModel]
    if (presets === undefined) {
        return options?.allowUnlistedModel === true && Boolean(trimmedModel)
    }
    return presets.includes(normalizedEffort as ClaudeEffortPreset)
}
