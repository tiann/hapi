import {
    AGY_MODEL_LABELS,
    AGY_MODEL_PRESETS,
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_LEVELS,
    CLAUDE_MODEL_LABELS,
    CLAUDE_MODEL_PRESETS,
    GEMINI_MODEL_LABELS,
    GEMINI_MODEL_PRESETS
} from '@hapi/protocol'
import type { AgentFlavor } from '@hapi/protocol'

export type AgentType = AgentFlavor
export type SessionType = 'simple' | 'worktree'
// Codex reports supported efforts dynamically; keep this open for new server values.
export type CodexReasoningEffort = string
// Grok reports effort values dynamically through ACP, while Claude uses the
// fixed ClaudeEffortLevel catalog.
export type LaunchEffort = string
export type NewSessionServiceTier = 'standard' | 'fast'

function modelPresetOptions<TModel extends string>(
    presets: readonly TModel[],
    labels: Record<TModel, string>
): { value: string; label: string }[] {
    return presets.map(model => ({ value: model, label: labels[model] }))
}

export const MODEL_OPTIONS: Record<AgentType, { value: string; label: string }[]> = {
    agy: [
        { value: 'auto', label: 'Default' },
        ...modelPresetOptions(AGY_MODEL_PRESETS, AGY_MODEL_LABELS),
    ],
    claude: [
        { value: 'auto', label: 'Default' },
        ...modelPresetOptions(CLAUDE_MODEL_PRESETS, CLAUDE_MODEL_LABELS),
    ],
    codex: [
        { value: 'auto', label: 'Default' },
    ],
    dsh: [],
    cursor: [],
    kimi: [
        { value: 'auto', label: 'Default' },
    ],
    copilot: [
        { value: 'auto', label: 'Auto' },
    ],
    gemini: [
        { value: 'auto', label: 'Default' },
        ...modelPresetOptions(GEMINI_MODEL_PRESETS, GEMINI_MODEL_LABELS),
    ],
    opencode: [],
    grok: [],
    pi: [],
}

export const CODEX_REASONING_EFFORT_OPTIONS: { value: CodexReasoningEffort; label: string }[] = [
    { value: 'default', label: 'Default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
    { value: 'max', label: 'Max' },
]

/**
 * Whether a saved/selected opencode reasoning effort is still valid for the
 * current option set. Effort values are arbitrary model-provided strings
 * (`CodexReasoningEffort` is a `string` alias, and dynamic variant lists from
 * the OpenCode catalog may contain values beyond the static presets, e.g.
 * `minimal` or `none`). `dynamicVariants` is the selected model's real variant
 * list when the catalog is loaded (empty = model has none), or null when the
 * catalog is unavailable and the static fallback list applies.
 */
export function isOpencodeReasoningEffortValid(
    effort: CodexReasoningEffort,
    dynamicVariants: string[] | null
): boolean {
    if (effort === 'default') return true
    const allowed = dynamicVariants
        ?? CODEX_REASONING_EFFORT_OPTIONS.map((option) => option.value).filter((value) => value !== 'xhigh')
    return allowed.includes(effort)
}

export const CLAUDE_EFFORT_OPTIONS: { value: LaunchEffort; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    ...CLAUDE_EFFORT_LEVELS.map((value) => ({ value, label: CLAUDE_EFFORT_LABELS[value] })),
]

export const GROK_EFFORT_OPTIONS: { value: LaunchEffort; label: string }[] = [
    { value: 'auto', label: 'Default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
]
