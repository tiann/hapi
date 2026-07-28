import { z } from 'zod'

/**
 * @description The legacy payload type identifier used for all generic agent messages.
 * Changing this value will affect the communication schema between CLI, Hub, and Web.
 * A migration plan is required if this literal is ever modified.
 */
export const AGENT_MESSAGE_PAYLOAD_TYPE = 'codex' as const

export const AGENT_FLAVORS = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'kimi', 'opencode', 'pi'] as const
export type AgentFlavor = typeof AGENT_FLAVORS[number]
export const AgentFlavorSchema = z.enum(AGENT_FLAVORS)

// Flavors offered when CREATING a new session. Gemini CLI is intentionally
// excluded: Google sunset the consumer Gemini CLI (2026-06-18) so it can no
// longer be launched. It is kept in AGENT_FLAVORS / AgentFlavorSchema above so
// existing stored Gemini sessions still validate and remain viewable.
export const CREATABLE_AGENT_FLAVORS: readonly AgentFlavor[] = AGENT_FLAVORS.filter(
    (flavor) => flavor !== 'gemini'
)

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'] as const
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number]

export const CODEX_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number]

export const CODEX_COLLABORATION_MODES = ['default', 'plan'] as const
export type CodexCollaborationMode = typeof CODEX_COLLABORATION_MODES[number]

export const GEMINI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type GeminiPermissionMode = typeof GEMINI_PERMISSION_MODES[number]

export const KIMI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type KimiPermissionMode = typeof KIMI_PERMISSION_MODES[number]

export const GROK_PERMISSION_MODES = ['default', 'auto', 'plan', 'bypassPermissions'] as const
export type GrokPermissionMode = typeof GROK_PERMISSION_MODES[number]

export const OPENCODE_PERMISSION_MODES = ['default', 'plan', 'yolo'] as const
export type OpencodePermissionMode = typeof OPENCODE_PERMISSION_MODES[number]

export const CURSOR_PERMISSION_MODES = ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'] as const
export type CursorPermissionMode = typeof CURSOR_PERMISSION_MODES[number]

export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'plan',
    'ask',
    'debug',
    'autoReview',
    'read-only',
    'safe-yolo',
    'yolo'
] as const
export type PermissionMode = typeof PERMISSION_MODES[number]


export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    auto: 'Auto',
    plan: 'Plan Mode',
    ask: 'Ask Mode',
    debug: 'Debug Mode',
    autoReview: 'Auto-review',
    bypassPermissions: 'Yolo',
    'read-only': 'Read Only',
    'safe-yolo': 'Safe Yolo',
    yolo: 'Yolo'
}

export type PermissionModeTone = 'neutral' | 'info' | 'warning' | 'danger'

export const PERMISSION_MODE_TONES: Record<PermissionMode, PermissionModeTone> = {
    default: 'neutral',
    acceptEdits: 'warning',
    auto: 'warning',
    plan: 'info',
    ask: 'info',
    debug: 'info',
    autoReview: 'warning',
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

export const CODEX_COLLABORATION_MODE_LABELS: Record<CodexCollaborationMode, string> = {
    default: 'Default',
    plan: 'Plan'
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

export function getPermissionModesForFlavor(flavor?: string | null): readonly PermissionMode[] {
    if (flavor === 'codex') {
        return CODEX_PERMISSION_MODES
    }
    if (flavor === 'gemini') {
        return GEMINI_PERMISSION_MODES
    }
    if (flavor === 'kimi') {
        return KIMI_PERMISSION_MODES
    }
    if (flavor === 'grok') {
        return GROK_PERMISSION_MODES
    }
    if (flavor === 'opencode') {
        return OPENCODE_PERMISSION_MODES
    }
    if (flavor === 'cursor') {
        return CURSOR_PERMISSION_MODES
    }
    if (flavor === 'pi') {
        // Pi RPC mode has no runtime permission switching (always auto-approve);
        // no permission modes are offered.
        return []
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
