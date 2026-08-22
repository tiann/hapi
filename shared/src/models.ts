import { CLAUDE_EFFORT_LEVELS } from './effort'

// Role B — recognized aliases: every Claude model id/preset the UI knows how
// to label or classify (context-window family, subagent badge, etc.),
// including legacy `[1m]` presets that existing sessions may still carry in
// their stored model string even though the live CLI model catalog (role A,
// see CLAUDE_MODEL_FALLBACK_OPTIONS below) no longer offers them as distinct
// choices. `list_models` showed bare `sonnet`/`opus`/`fable` already carry
// their family's real (large) context window, so the `[1m]` suffix was never
// a second, smaller-window model — keeping these keys here (not in the offer
// list) is what lets old sessions keep resolving correctly without
// resurrecting the misleading picker duplicates.
export const CLAUDE_MODEL_LABELS = {
    sonnet: 'Sonnet',
    'sonnet[1m]': 'Sonnet 1M',
    opus: 'Opus',
    'opus[1m]': 'Opus 1M',
    fable: 'Fable',
    'fable[1m]': 'Fable 1M',
    haiku: 'Haiku'
} as const

export type ClaudeModelPreset = keyof typeof CLAUDE_MODEL_LABELS

// Role A — offer list: what the picker shows when the live `claude` CLI
// model catalog can't be queried (older CLI, probe failure, offline
// machine). Deliberately has no bare/`[1m]` pairs, mirroring the live
// catalog's one-row-per-family shape, and listed in the same order the
// live catalog returns (opus, fable, sonnet, haiku) so the picker doesn't
// reshuffle when discovery drops in or out.
//
// `supportedEffortLevels` mirrors the field of the same name on
// `ClaudeModelSummary` (shared/src/apiTypes.ts) on purpose -- this list is
// itself hand-maintained (we picked these four models, we wrote their
// labels), so unlike the live catalog's field, whose *absence* is
// ambiguous until another row confirms the CLI reports it at all, our own
// absence/presence here is never ambiguous: we know exactly which models we
// hardcoded support for `--effort` and which don't. Leaving capability out
// while hardcoding identity would be the same self-contradiction this PR
// otherwise fixes for the live catalog. haiku's `[]` (not `undefined`) is
// a confirmed zero, measured against claude 2.1.233 on 2026-08-16 -- same
// contract as a live catalog row that reports the field.
export const CLAUDE_MODEL_FALLBACK_OPTIONS: { value: ClaudeModelPreset; label: string; supportedEffortLevels?: string[] }[] = [
    { value: 'opus', label: CLAUDE_MODEL_LABELS.opus, supportedEffortLevels: [...CLAUDE_EFFORT_LEVELS] },
    { value: 'fable', label: CLAUDE_MODEL_LABELS.fable, supportedEffortLevels: [...CLAUDE_EFFORT_LEVELS] },
    { value: 'sonnet', label: CLAUDE_MODEL_LABELS.sonnet, supportedEffortLevels: [...CLAUDE_EFFORT_LEVELS] },
    { value: 'haiku', label: CLAUDE_MODEL_LABELS.haiku, supportedEffortLevels: [] }
]

export const GEMINI_MODEL_LABELS = {
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
    'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
} as const

export type GeminiModelPreset = keyof typeof GEMINI_MODEL_LABELS
export const GEMINI_MODEL_PRESETS = Object.keys(GEMINI_MODEL_LABELS) as GeminiModelPreset[]
export const DEFAULT_GEMINI_MODEL: GeminiModelPreset = 'gemini-2.5-pro'

// Order and labels mirror `agy models` output (the agy CLI's own listing) so the
// HAPI picker matches what users see in the terminal. IDs follow agy's
// `<model>-<effort>` convention (e.g. `gemini-3.5-flash-low` verified accepted by
// `agy --model`). NOTE: agy fetches the live list server-side and `agy models`
// needs an interactive keyring unlock, so this stays a hand-maintained mirror —
// update it when agy's listing changes.
export const AGY_MODEL_LABELS = {
    'gemini-3.6-flash-high': 'Gemini 3.6 Flash (High)',
    'gemini-3.6-flash-medium': 'Gemini 3.6 Flash (Medium)',
    'gemini-3.6-flash-low': 'Gemini 3.6 Flash (Low)',
    'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
    'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
    'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
    'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
    'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
    'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
} as const

export type AgyModelPreset = keyof typeof AGY_MODEL_LABELS
export const AGY_MODEL_PRESETS = Object.keys(AGY_MODEL_LABELS) as AgyModelPreset[]

export function getAgyModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) return null
    return AGY_MODEL_LABELS[trimmedModel as AgyModelPreset] ?? null
}

export function isClaudeModelPreset(model: string | null | undefined): model is ClaudeModelPreset {
    return typeof model === 'string' && Object.hasOwn(CLAUDE_MODEL_LABELS, model)
}

export function getClaudeModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return CLAUDE_MODEL_LABELS[trimmedModel as ClaudeModelPreset] ?? null
}
