export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number]

export const CODEX_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number]

export const GEMINI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type GeminiPermissionMode = typeof GEMINI_PERMISSION_MODES[number]

export const OPENCODE_PERMISSION_MODES = ['default', 'yolo'] as const
export type OpencodePermissionMode = typeof OPENCODE_PERMISSION_MODES[number]

export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo'
] as const
export type PermissionMode = typeof PERMISSION_MODES[number]

export const MODEL_MODES = ['default', 'sonnet', 'opus'] as const
export type ModelMode = typeof MODEL_MODES[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const
export type EffortLevel = typeof EFFORT_LEVELS[number]

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | 'opencode'

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    plan: 'Plan Mode',
    bypassPermissions: 'Yolo',
    'read-only': 'Read Only',
    'safe-yolo': 'Safe Yolo',
    yolo: 'Yolo'
}

export type PermissionModeTone = 'neutral' | 'info' | 'warning' | 'danger'

export const PERMISSION_MODE_TONES: Record<PermissionMode, PermissionModeTone> = {
    default: 'neutral',
    acceptEdits: 'warning',
    plan: 'info',
    bypassPermissions: 'danger',
    'read-only': 'warning',
    'safe-yolo': 'warning',
    yolo: 'danger'
}

export type PermissionModeOption = {
    mode: PermissionMode
    label: string
    tone: PermissionModeTone
}

export const MODEL_MODE_LABELS: Record<ModelMode, string> = {
    default: 'Default',
    sonnet: 'Sonnet',
    opus: 'Opus'
}

export const EFFORT_LEVEL_LABELS: Record<EffortLevel, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High'
}

export function getPermissionModeLabel(mode: PermissionMode): string {
    return PERMISSION_MODE_LABELS[mode]
}

export function getPermissionModeTone(mode: PermissionMode): PermissionModeTone {
    return PERMISSION_MODE_TONES[mode]
}

export function getPermissionModesForFlavor(flavor?: string | null): readonly PermissionMode[] {
    if (flavor === 'codex') {
        return CODEX_PERMISSION_MODES
    }
    if (flavor === 'gemini') {
        return GEMINI_PERMISSION_MODES
    }
    if (flavor === 'opencode') {
        return OPENCODE_PERMISSION_MODES
    }
    return CLAUDE_PERMISSION_MODES
}

export function getPermissionModeOptionsForFlavor(flavor?: string | null): PermissionModeOption[] {
    return getPermissionModesForFlavor(flavor).map((mode) => ({
        mode,
        label: getPermissionModeLabel(mode),
        tone: getPermissionModeTone(mode)
    }))
}

export function isPermissionModeAllowedForFlavor(mode: PermissionMode, flavor?: string | null): boolean {
    return getPermissionModesForFlavor(flavor).includes(mode)
}

export function getModelModesForFlavor(flavor?: string | null): readonly ModelMode[] {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode') {
        return []
    }
    return MODEL_MODES
}

export function isModelModeAllowedForFlavor(mode: ModelMode, flavor?: string | null): boolean {
    return getModelModesForFlavor(flavor).includes(mode)
}

export function getEffortLevelsForFlavor(flavor?: string | null): readonly EffortLevel[] {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode') {
        return []
    }
    return EFFORT_LEVELS
}

export function isEffortLevelAllowedForFlavor(level: EffortLevel, flavor?: string | null): boolean {
    return getEffortLevelsForFlavor(flavor).includes(level)
}
