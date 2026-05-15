import { GEMINI_MODEL_PRESETS, GEMINI_MODEL_LABELS, CLAUDE_PERMISSION_MODES, PERMISSION_MODE_LABELS } from '@hapi/protocol'
import type { ClaudePermissionMode } from '@hapi/protocol'

export type { ClaudePermissionMode }

export type AgentType = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode'
export type SessionType = 'simple' | 'worktree'
export type CodexReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh'
export type ClaudeEffort = 'auto' | 'medium' | 'high' | 'max'

export const MODEL_OPTIONS: Record<AgentType, { value: string; label: string }[]> = {
    claude: [
        { value: 'auto', label: 'Default' },
        { value: 'opus', label: 'Opus' },
        { value: 'opus[1m]', label: 'Opus 1M' },
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'sonnet[1m]', label: 'Sonnet 1M' },
    ],
    codex: [
        { value: 'auto', label: 'Default' },
    ],
    cursor: [],
    gemini: [
        { value: 'auto', label: 'Default' },
        ...GEMINI_MODEL_PRESETS.map(m => ({ value: m, label: GEMINI_MODEL_LABELS[m] })),
    ],
    opencode: [],
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
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
]

export const CLAUDE_PERMISSION_MODE_OPTIONS: { value: ClaudePermissionMode; label: string }[] =
    CLAUDE_PERMISSION_MODES.map((mode) => ({ value: mode, label: PERMISSION_MODE_LABELS[mode] }))
