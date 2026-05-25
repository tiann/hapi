import {
    CLAUDE_MODEL_LABELS,
    CLAUDE_MODEL_PRESETS,
    GEMINI_MODEL_LABELS,
    GEMINI_MODEL_PRESETS
} from '@hapi/protocol'
import {
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_PRESETS,
    type ClaudeEffortPreset
} from '@/lib/claude-effort'
import type { AgentDescriptor } from '@hapi/protocol/plugins'

export type AgentType = string
export type SessionType = 'simple' | 'worktree'
export type CodexReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh'
export type ClaudeEffort = 'auto' | ClaudeEffortPreset

function modelPresetOptions<TModel extends string>(
    presets: readonly TModel[],
    labels: Record<TModel, string>
): { value: string; label: string }[] {
    return presets.map(model => ({ value: model, label: labels[model] }))
}

export const BUILTIN_MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
    claude: [
        { value: 'auto', label: 'Default' },
        ...modelPresetOptions(CLAUDE_MODEL_PRESETS, CLAUDE_MODEL_LABELS),
    ],
    codex: [
        { value: 'auto', label: 'Default' },
    ],
    cursor: [],
    kimi: [
        { value: 'auto', label: 'Default' },
    ],
    gemini: [
        { value: 'auto', label: 'Default' },
        ...modelPresetOptions(GEMINI_MODEL_PRESETS, GEMINI_MODEL_LABELS),
    ],
    opencode: [],
}
export const MODEL_OPTIONS = BUILTIN_MODEL_OPTIONS

export function getModelOptions(agent: AgentType): { value: string; label: string }[] {
    return BUILTIN_MODEL_OPTIONS[agent] ?? []
}

export function agentSupportsYolo(descriptor: AgentDescriptor | null | undefined): boolean {
    return descriptor?.capabilities.permissionModes.some((mode) => mode === 'yolo' || mode === 'bypassPermissions') ?? false
}

export const CODEX_REASONING_EFFORT_OPTIONS: { value: CodexReasoningEffort; label: string }[] = [
    { value: 'default', label: 'Default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
]

export const CLAUDE_EFFORT_OPTIONS: { value: ClaudeEffort; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    ...CLAUDE_EFFORT_PRESETS.map((effort) => ({
        value: effort,
        label: CLAUDE_EFFORT_LABELS[effort]
    })),
]
