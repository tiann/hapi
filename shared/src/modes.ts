/**
 * @description The legacy payload type identifier used for all generic agent messages.
 * Changing this value will affect the communication schema between CLI, Hub, and Web.
 * A migration plan is required if this literal is ever modified.
 */
export const AGENT_MESSAGE_PAYLOAD_TYPE = 'codex' as const

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number]

export const CODEX_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number]

export const CODEX_COLLABORATION_MODES = ['default', 'plan'] as const
export type CodexCollaborationMode = typeof CODEX_COLLABORATION_MODES[number]

export const CODEX_SERVICE_TIERS = ['standard', 'fast'] as const
export type CodexServiceTier = typeof CODEX_SERVICE_TIERS[number]

export const AGY_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type AgyPermissionMode = typeof AGY_PERMISSION_MODES[number]

export const GROK_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type GrokPermissionMode = typeof GROK_PERMISSION_MODES[number]

export const OPENCODE_PERMISSION_MODES = ['default', 'yolo'] as const
export type OpencodePermissionMode = typeof OPENCODE_PERMISSION_MODES[number]

export const HERMES_MOA_PERMISSION_MODES = ['default', 'yolo'] as const
export type HermesMoaPermissionMode = typeof HERMES_MOA_PERMISSION_MODES[number]

export const CURSOR_PERMISSION_MODES = ['default', 'plan', 'ask', 'yolo'] as const
export type CursorPermissionMode = typeof CURSOR_PERMISSION_MODES[number]

export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'ask',
    'read-only',
    'safe-yolo',
    'yolo'
] as const
export type PermissionMode = typeof PERMISSION_MODES[number]

export const AGENT_FLAVORS = [
    'claude',
    'claude-deepseek',
    'claude-ark',
    'cc-api',
    'codex',
    'agy',
    'grok',
    'opencode',
    'cursor',
    'hermes-moa'
] as const
export type AgentFlavor = typeof AGENT_FLAVORS[number]

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    plan: 'Plan Mode',
    ask: 'Ask Mode',
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
    ask: 'info',
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

export type CodexCollaborationModeOption = {
    mode: CodexCollaborationMode
    label: string
}

export type CodexServiceTierOption = {
    tier: CodexServiceTier
    label: string
}

export const CODEX_COLLABORATION_MODE_LABELS: Record<CodexCollaborationMode, string> = {
    default: 'Default',
    plan: 'Plan'
}

export const CODEX_SERVICE_TIER_LABELS: Record<CodexServiceTier, string> = {
    standard: 'Standard',
    fast: 'Fast'
}

export function getPermissionModeLabel(mode: PermissionMode): string {
    return PERMISSION_MODE_LABELS[mode]
}

export function getPermissionModeTone(mode: PermissionMode): PermissionModeTone {
    return PERMISSION_MODE_TONES[mode]
}

export function getCodexCollaborationModeLabel(mode: CodexCollaborationMode): string {
    return CODEX_COLLABORATION_MODE_LABELS[mode]
}

export function getCodexServiceTierLabel(tier: CodexServiceTier): string {
    return CODEX_SERVICE_TIER_LABELS[tier]
}

export function getPermissionModesForFlavor(flavor?: string | null): readonly PermissionMode[] {
    if (flavor === 'codex') {
        return CODEX_PERMISSION_MODES
    }
    if (flavor === 'agy') {
        return AGY_PERMISSION_MODES
    }
    if (flavor === 'grok') {
        return GROK_PERMISSION_MODES
    }
    if (flavor === 'opencode') {
        return OPENCODE_PERMISSION_MODES
    }
    if (flavor === 'hermes-moa') {
        return HERMES_MOA_PERMISSION_MODES
    }
    if (flavor === 'cursor') {
        return CURSOR_PERMISSION_MODES
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

export function getCodexCollaborationModeOptions(): CodexCollaborationModeOption[] {
    return CODEX_COLLABORATION_MODES.map((mode) => ({
        mode,
        label: getCodexCollaborationModeLabel(mode)
    }))
}

export function getCodexServiceTierOptions(): CodexServiceTierOption[] {
    return CODEX_SERVICE_TIERS.map((tier) => ({
        tier,
        label: getCodexServiceTierLabel(tier)
    }))
}
