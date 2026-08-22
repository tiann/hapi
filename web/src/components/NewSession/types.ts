import {
    AGY_MODEL_LABELS,
    AGY_MODEL_PRESETS,
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_LEVELS,
    CLAUDE_MODEL_FALLBACK_OPTIONS,
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
    // Fallback shown when the live CLI model catalog (useClaudeModelsForCwd)
    // can't be queried -- no bare/[1m] duplicate pairs, one row per family.
    claude: [
        { value: 'auto', label: 'Default' },
        // Projected to {value, label}: supportedEffortLevels is capability data
        // for the effort field, and must not ride into a picker option object
        // (see getClaudeComposerModelOptions in AssistantChat/claudeModelOptions.ts).
        ...CLAUDE_MODEL_FALLBACK_OPTIONS.map(({ value, label }) => ({ value, label })),
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
