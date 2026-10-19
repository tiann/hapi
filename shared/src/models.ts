import type { ClaudeModelSummary } from './apiTypes'

export const CLAUDE_MODEL_LABELS = {
    sonnet: 'Sonnet',
    'sonnet[1m]': 'Sonnet 1M',
    opus: 'Opus',
    'opus[1m]': 'Opus 1M',
    fable: 'Fable',
    'fable[1m]': 'Fable 1M'
} as const

export type ClaudeModelPreset = keyof typeof CLAUDE_MODEL_LABELS
export const CLAUDE_MODEL_PRESETS = Object.keys(CLAUDE_MODEL_LABELS) as ClaudeModelPreset[]

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
    'gemini-3.7-flash-high': 'Gemini 3.7 Flash (High)',
    'gemini-3.7-flash-medium': 'Gemini 3.7 Flash (Medium)',
    'gemini-3.7-flash-low': 'Gemini 3.7 Flash (Low)',
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

/**
 * A Claude model the user can pick.
 *
 * `value` is stored on the session and passed to `claude --model` unchanged.
 * An alias (`opus`) is resolved by the CLI each time the session's claude
 * process starts, so the session moves to a newer model on its next start;
 * a full id (`claude-opus-4-7`) stays on that model.
 */
export type ClaudeModelChoice = {
    value: string
    label: string
}

/**
 * Picker choices for a catalog reported by the `claude` CLI: its own `/model`
 * rows, in its order and with its display names. The `default` row is omitted;
 * callers represent it as "no model".
 */
export function getClaudeModelChoices(catalog: readonly ClaudeModelSummary[]): ClaudeModelChoice[] {
    return catalog
        .filter((model) => model.value !== 'default')
        .map((model) => ({ value: model.value, label: model.displayName ?? model.value }))
}

/**
 * Effort levels the CLI offers for `model` (`null` = the session default).
 * Undefined when the catalog is missing or does not list the model.
 */
export function getClaudeEffortLevelsForModel(
    model: string | null,
    catalog: readonly ClaudeModelSummary[] | null | undefined
): readonly string[] | undefined {
    if (!catalog) {
        return undefined
    }
    if (model === null) {
        return catalog.find((row) => row.value === 'default')?.effortLevels
    }
    return catalog.find((row) => row.value === model)?.effortLevels
}

/**
 * The effort to keep when switching to `model`: an effort the model does not
 * offer is cleared rather than left for the CLI to reject or ignore. Unknown
 * support keeps the current effort.
 */
export function resolveClaudeEffortForModel(
    effort: string | null,
    model: string | null,
    catalog: readonly ClaudeModelSummary[] | null | undefined
): string | null {
    const levels = getClaudeEffortLevelsForModel(model, catalog)
    if (effort === null || levels === undefined || levels.includes(effort)) {
        return effort
    }
    return null
}
