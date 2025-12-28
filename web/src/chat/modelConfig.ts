import type { ModelMode } from '@/types/api'

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

const MODEL_CONTEXT_WINDOWS: Record<ModelMode, number> = {
    // Claude Code modes used in this app; currently treated as ~200k context.
    default: 200_000,
    sonnet: 200_000,
    opus: 200_000
}

export function getContextBudgetTokens(modelMode: ModelMode | undefined): number | null {
    const mode: ModelMode = modelMode ?? 'default'
    const windowTokens = MODEL_CONTEXT_WINDOWS[mode]
    if (!windowTokens) return null
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
