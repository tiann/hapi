import { isClaudeModelPreset } from '@hapi/protocol'

/**
 * Context windows vary by model/provider and may change over time.
 *
 * The UI only needs this to compute a conservative "context remaining" warning.
 * We intentionally keep a headroom budget to avoid false confidence near the limit
 * (system prompts, tool overhead, and other hidden tokens can consume extra space).
 *
 * If/when the server provides an explicit per-session context limit, prefer that
 * and use this only as a fallback.
 */
const CONTEXT_HEADROOM_TOKENS = 10_000
const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000
const LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000
const CODEX_372K_CONTEXT_WINDOW_TOKENS = 372_000
const CODEX_272K_CONTEXT_WINDOW_TOKENS = 272_000
const CODEX_128K_CONTEXT_WINDOW_TOKENS = 128_000
const ARK_1024K_CONTEXT_WINDOW_TOKENS = 1_024_000
const HALF_MILLION_CONTEXT_WINDOW_TOKENS = 512_000
const QUARTER_MILLION_CONTEXT_WINDOW_TOKENS = 256_000
const KIMI_K3_CONTEXT_WINDOW_TOKENS = 1_048_576

function normalizeModelForFamilyCheck(model: string): string {
    return model.trim().toLowerCase().replace(/\[(1|2)m\]$/, '')
}

function isClaudeModelFamily(model: string, family: string): boolean {
    const normalizedModel = normalizeModelForFamilyCheck(model)
    return normalizedModel === family || normalizedModel.startsWith(`${family}-`)
}

export function getContextBudgetTokens(model: string | null | undefined, flavor?: string | null): number | null {
    const trimmedModel = model?.trim()
    const normalizedModel = trimmedModel?.toLowerCase()
    const windowTokens = (() => {
        if (flavor === 'claude-deepseek') {
            switch (normalizeModelForFamilyCheck(normalizedModel ?? '')) {
                case 'deepseek-v4-pro':
                case 'deepseek-v4-flash':
                    return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
                default:
                    return null
            }
        }

        if (flavor === 'cc-api') {
            switch (normalizedModel) {
                case 'doubao-seed-2.1-pro':
                    return 262_144
                case 'glm-5.2':
                case 'glm-5.2[1m]':
                    return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
                case 'minimax-m3':
                    // MiniMax API lists 1M, but MiniMax's current Claude Code
                    // integration docs configure a 512K auto-compact window.
                    return HALF_MILLION_CONTEXT_WINDOW_TOKENS
                case 'kimi-k3':
                    // Moonshot's live model metadata reports exactly 1,048,576.
                    return KIMI_K3_CONTEXT_WINDOW_TOKENS
                default:
                    return null
            }
        }

        if (flavor === 'claude-ark') {
            switch (normalizedModel) {
                case 'deepseek-v4-pro':
                case 'deepseek-v4-flash':
                case 'glm-5.2':
                    return ARK_1024K_CONTEXT_WINDOW_TOKENS
                case 'minimax-m3':
                    return HALF_MILLION_CONTEXT_WINDOW_TOKENS
                case 'minimax-m2.7':
                    return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
                case 'kimi-k2.7-code':
                case 'kimi-k2.6':
                    return QUARTER_MILLION_CONTEXT_WINDOW_TOKENS
                default:
                    return null
            }
        }

        if (flavor === 'codex') {
            switch (normalizedModel) {
                case 'gpt-5.6':
                case 'gpt-5.6-sol':
                case 'gpt-5.6-terra':
                case 'gpt-5.6-luna':
                    return CODEX_372K_CONTEXT_WINDOW_TOKENS
                case 'gpt-5.5':
                case 'gpt-5.4':
                case 'gpt-5.4-mini':
                    return CODEX_272K_CONTEXT_WINDOW_TOKENS
                case 'gpt-5.3-codex-spark':
                    return CODEX_128K_CONTEXT_WINDOW_TOKENS
                default:
                    return null
            }
        }

        if (flavor !== 'claude') {
            return null
        }

        if (!trimmedModel) {
            return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (trimmedModel === 'fable' || isClaudeModelFamily(trimmedModel, 'claude-fable-5')) {
            return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (trimmedModel === 'sonnet' || isClaudeModelFamily(trimmedModel, 'claude-sonnet-5')) {
            return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (normalizeModelForFamilyCheck(trimmedModel) === 'haiku' || isClaudeModelFamily(trimmedModel, 'claude-haiku-4-5')) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (trimmedModel === 'opus' || trimmedModel.endsWith('[1m]')) {
            return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (trimmedModel === 'claude-opus-4-8' || trimmedModel.startsWith('claude-opus-4-8-')) {
            return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (isClaudeModelPreset(trimmedModel)) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (trimmedModel.startsWith('claude-')) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        return null
    })()

    if (!windowTokens) return null
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
