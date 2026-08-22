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
// Real context windows measured via the claude CLI's `get_context_usage` control
// request (2026-08-16, claude 2.1.233): bare and `[1m]`-suffixed ids of the same
// model family report the *same* window -- the suffix carries no window
// information at all. Only the model family (not the suffix) determines the
// window, and haiku is the one family still at the historical 200k default
// (DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS above), so it needs no entry here.
const CLAUDE_FAMILY_CONTEXT_WINDOW_TOKENS = {
    sonnet: 967_000,
    opus: 1_000_000,
    fable: 1_000_000
} as const
type ClaudeContextWindowFamily = keyof typeof CLAUDE_FAMILY_CONTEXT_WINDOW_TOKENS
// Used only for an *unrecognized* full/preset id that carries a "[1m]" suffix
// (e.g. an older generation's "claude-opus-4-8[1m]", or a future preset this
// file hasn't measured yet) -- coincidentally the same number as the opus/fable
// family window above, but kept as its own named fallback since it is a guess
// for an unknown model, not a measurement.
const LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000

// Fallback for Codex sessions when the server has not reported an explicit modelContextWindow.
// The value matches the context window currently reported by Codex App Server token-count events.
const DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 258_400
// Pi supports multiple providers with varying context windows. 200K is a
// conservative default (most Claude/GPT-4 class models). When the server
// reports an explicit modelContextWindow via usage events, that takes
// precedence over this fallback.
const DEFAULT_PI_CONTEXT_WINDOW_TOKENS = 200_000

function parseCursorWireContextWindow(model: string): number | null {
    const match = model.match(/\[([^\]]+)\]/)
    if (!match) {
        return null
    }
    for (const segment of match[1].split(',')) {
        const part = segment.trim()
        const eq = part.indexOf('=')
        if (eq === -1 || part.slice(0, eq).trim() !== 'context') {
            continue
        }
        const raw = part.slice(eq + 1).trim().toLowerCase()
        const digits = raw.match(/(\d+)/)?.[1]
        if (!digits) {
            return null
        }
        const value = Number.parseInt(digits, 10)
        if (!Number.isFinite(value) || value <= 0) {
            return null
        }
        return raw.endsWith('k') ? value * 1000 : value
    }
    return null
}

// Strips a trailing "[1m]" suffix. The suffix carries no context-window
// information on its own (measured fact, see CLAUDE_FAMILY_CONTEXT_WINDOW_TOKENS
// above) -- normalizing it away before family lookup means a bare id and its
// "[1m]" counterpart (e.g. "sonnet" and "sonnet[1m]", or a legacy stored
// "claude-sonnet-5[1m]") resolve to the same window instead of being judged by
// suffix presence.
function stripClaude1mSuffix(model: string): string {
    return model.endsWith('[1m]') ? model.slice(0, -'[1m]'.length) : model
}

// Only ids/aliases this file has an actual measurement for. Deliberately NOT a
// generic "contains 'sonnet'/'opus'" match: an older or future generation
// sharing a family name (e.g. a hypothetical "claude-sonnet-4-6") has no
// verified window here, so it must fall through to the legacy suffix-based
// guess below rather than being assumed to share the current generation's
// window.
function resolveClaudeContextWindowFamily(normalizedModel: string): ClaudeContextWindowFamily | null {
    if (normalizedModel === 'sonnet' || normalizedModel === 'claude-sonnet-5') {
        return 'sonnet'
    }
    if (normalizedModel === 'opus' || normalizedModel === 'claude-opus-5') {
        return 'opus'
    }
    // Fable already used a broad `startsWith` before this PR (its 1M window
    // holds across generations badged "claude-fable-*" so far) -- kept as-is.
    if (normalizedModel === 'fable' || normalizedModel.startsWith('claude-fable')) {
        return 'fable'
    }
    return null
}

export function getContextBudgetTokens(model: string | null | undefined, flavor?: string | null): number | null {
    if (flavor === 'codex') {
        return Math.max(1, DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor === 'pi') {
        return Math.max(1, DEFAULT_PI_CONTEXT_WINDOW_TOKENS - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor === 'cursor') {
        const trimmedModel = model?.trim()
        const windowTokens = trimmedModel ? parseCursorWireContextWindow(trimmedModel) : null
        if (!windowTokens) {
            return null
        }
        return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor !== 'claude') {
        return null
    }

    const trimmedModel = model?.trim()
    const windowTokens = (() => {
        if (!trimmedModel) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }

        // The '[1m]' suffix carries no context-window information, so the
        // family lookup deliberately strips it instead of treating it as a
        // signal. Measured on claude 2.1.233/2.1.234 against both a Pro and a
        // Max account: sonnet and sonnet[1m] both report 967,000, opus and
        // fable both report 1,000,000 with and without the suffix, and haiku
        // reports 200,000. These numbers are the same on both tiers, so a
        // family window is a measurement rather than an optimistic guess.
        // This value is only the pre-measurement seed in any case -- the first
        // turn's get_context_usage reading replaces it (see
        // seedMeasuredContextWindow in cli/src/claude/utils/sdkToLogConverter.ts).
        const family = resolveClaudeContextWindowFamily(stripClaude1mSuffix(trimmedModel))
        if (family) {
            return CLAUDE_FAMILY_CONTEXT_WINDOW_TOKENS[family]
        }

        if (isClaudeModelPreset(trimmedModel) || trimmedModel.startsWith('claude-')) {
            // Not a family we have a real measurement for (haiku, an
            // unrecognized full SDK id from another generation, etc.) --
            // fall back to the legacy suffix-based guess.
            return trimmedModel.endsWith('[1m]')
                ? LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
                : DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        return null
    })()

    if (!windowTokens) return null
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
