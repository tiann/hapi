import {
    ARK_MODEL_LABELS,
    ARK_MODEL_PRESETS,
    CC_API_MODEL_LABELS,
    CC_API_MODEL_PRESETS,
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_PRESETS,
    CLAUDE_DEEPSEEK_MODEL_LABELS,
    CLAUDE_DEEPSEEK_MODEL_PRESETS,
    CLAUDE_MODEL_PRESETS,
    DEFAULT_CLAUDE_MODEL_LABEL,
    AGY_MODEL_PRESETS,
    AGY_MODEL_LABELS,
    HERMES_MOA_PRESETS,
    HERMES_MOA_PRESET_LABELS,
    getClaudeModelLabel,
    type ClaudeEffortPreset,
} from '@hapi/protocol'

export type AgentType = 'claude' | 'claude-deepseek' | 'claude-ark' | 'cc-api' | 'codex' | 'cursor' | 'agy' | 'grok' | 'opencode' | 'hermes-moa'
export type SessionType = 'simple' | 'worktree'
export type CodexReasoningEffort = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
type CodexConcreteReasoningEffort = Exclude<CodexReasoningEffort, 'default'>
export type CodexServiceTier = 'default' | 'standard' | 'fast'
export type ClaudeEffort = 'auto' | ClaudeEffortPreset

export const MODEL_OPTIONS: Record<AgentType, { value: string; label: string }[]> = {
    claude: [
        { value: 'auto', label: DEFAULT_CLAUDE_MODEL_LABEL },
        ...CLAUDE_MODEL_PRESETS.map(m => ({ value: m, label: getClaudeModelLabel(m) ?? m })),
    ],
    'claude-deepseek': [
        ...CLAUDE_DEEPSEEK_MODEL_PRESETS.map(m => ({ value: m, label: CLAUDE_DEEPSEEK_MODEL_LABELS[m] })),
    ],
    'claude-ark': [
        ...ARK_MODEL_PRESETS.map(m => ({ value: m, label: ARK_MODEL_LABELS[m] })),
    ],
    'cc-api': [
        ...CC_API_MODEL_PRESETS.map(m => ({ value: m, label: CC_API_MODEL_LABELS[m] })),
    ],
    codex: [
        { value: 'auto', label: 'Auto' },
        { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · 372K' },
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 372K' },
        { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 372K' },
        { value: 'gpt-5.5', label: 'GPT-5.5 · 272K' },
        { value: 'gpt-5.4', label: 'GPT-5.4 · 272K' },
        { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini · 272K' },
        { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark · 128K' },
    ],
    cursor: [],
    agy: [
        ...AGY_MODEL_PRESETS.map(m => ({ value: m, label: AGY_MODEL_LABELS[m] })),
    ],
    grok: [
        { value: 'auto', label: 'Auto' },
        { value: 'grok-4.5', label: 'Grok 4.5' },
    ],
    opencode: [],
    'hermes-moa': [
        ...HERMES_MOA_PRESETS.map(m => ({ value: m, label: HERMES_MOA_PRESET_LABELS[m] })),
    ],
}

export const CODEX_REASONING_EFFORT_LABELS: Record<CodexReasoningEffort, string> = {
    default: 'Default',
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
    ultra: 'Ultra',
}

const CODEX_AUTO_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly CodexConcreteReasoningEffort[]
const CODEX_GPT_56_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly CodexConcreteReasoningEffort[]
const CODEX_GPT_56_ULTRA_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const satisfies readonly CodexConcreteReasoningEffort[]
const CODEX_GPT_55_54_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly CodexConcreteReasoningEffort[]
const CODEX_SPARK_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly CodexConcreteReasoningEffort[]

export const CODEX_REASONING_EFFORTS_BY_MODEL: Record<string, readonly CodexConcreteReasoningEffort[]> = {
    auto: CODEX_AUTO_REASONING_EFFORTS,
    'gpt-5.6': CODEX_GPT_56_ULTRA_REASONING_EFFORTS,
    'gpt-5.6-sol': CODEX_GPT_56_ULTRA_REASONING_EFFORTS,
    'gpt-5.6-terra': CODEX_GPT_56_ULTRA_REASONING_EFFORTS,
    'gpt-5.6-luna': CODEX_GPT_56_REASONING_EFFORTS,
    'gpt-5.5': CODEX_GPT_55_54_REASONING_EFFORTS,
    'gpt-5.4': CODEX_GPT_55_54_REASONING_EFFORTS,
    'gpt-5.4-mini': CODEX_GPT_55_54_REASONING_EFFORTS,
    'gpt-5.3-codex-spark': CODEX_SPARK_REASONING_EFFORTS,
}

export function getCodexReasoningEffortsForModel(model?: string | null): readonly CodexConcreteReasoningEffort[] {
    const normalizedModel = model?.trim().toLowerCase() || 'auto'
    return CODEX_REASONING_EFFORTS_BY_MODEL[normalizedModel] ?? CODEX_AUTO_REASONING_EFFORTS
}

export function getCodexReasoningEffortOptionsForModel(model?: string | null): { value: CodexReasoningEffort; label: string }[] {
    return [
        { value: 'default', label: CODEX_REASONING_EFFORT_LABELS.default },
        ...getCodexReasoningEffortsForModel(model).map((effort) => ({
            value: effort,
            label: CODEX_REASONING_EFFORT_LABELS[effort],
        })),
    ]
}

export function isCodexReasoningEffortAllowedForModel(model: string | null | undefined, effort: CodexReasoningEffort): boolean {
    if (effort === 'default') return true
    return getCodexReasoningEffortsForModel(model).includes(effort)
}

export const CODEX_REASONING_EFFORT_OPTIONS = getCodexReasoningEffortOptionsForModel('auto')

export const CODEX_SERVICE_TIER_OPTIONS: { value: CodexServiceTier; label: string }[] = [
    { value: 'default', label: 'Default' },
    { value: 'standard', label: 'Standard' },
    { value: 'fast', label: 'Fast' },
]

export const CLAUDE_EFFORT_OPTIONS: { value: ClaudeEffort; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    ...CLAUDE_EFFORT_PRESETS.map(effort => ({
        value: effort,
        label: CLAUDE_EFFORT_LABELS[effort],
    })),
]
