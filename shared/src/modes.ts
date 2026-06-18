import { z } from 'zod'

/**
 * @description The legacy payload type identifier used for all generic agent messages.
 * Changing this value will affect the communication schema between CLI, Hub, and Web.
 * A migration plan is required if this literal is ever modified.
 */
export const AGENT_MESSAGE_PAYLOAD_TYPE = 'codex' as const

export const AGENT_FLAVORS = ['claude', 'codex', 'cursor', 'gemini', 'kimi', 'opencode', 'pi'] as const
export type AgentFlavor = typeof AGENT_FLAVORS[number]
export const AgentFlavorSchema = z.enum(AGENT_FLAVORS)

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'] as const
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number]

export const CODEX_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number]

export const CODEX_COLLABORATION_MODES = ['default', 'plan'] as const
export type CodexCollaborationMode = typeof CODEX_COLLABORATION_MODES[number]

/**
 * Controls how a message sent while a turn is still running is delivered.
 * - `queue`: hold the message and deliver it only after the current turn fully
 *   ends (the existing, safe default — no interruption).
 * - `steer`: deliver the message into the running turn at the next step
 *   boundary via the Codex app-server `turn/steer` RPC (true, non-interrupting
 *   steering).
 * Only Codex exposes a non-interrupting steer primitive today. Claude Code's
 * real-time steering is interactive-TUI only — it is not reachable through the
 * Agent SDK / stream-json interface HAPI drives (upstream
 * anthropics/claude-agent-sdk-typescript#70), so Claude is intentionally
 * excluded until `session.send()` ships there.
 */
export const STEERING_MODES = ['queue', 'steer'] as const
export type SteeringMode = typeof STEERING_MODES[number]

export const GEMINI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type GeminiPermissionMode = typeof GEMINI_PERMISSION_MODES[number]

export const KIMI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type KimiPermissionMode = typeof KIMI_PERMISSION_MODES[number]

export const OPENCODE_PERMISSION_MODES = ['default', 'plan', 'yolo'] as const
export type OpencodePermissionMode = typeof OPENCODE_PERMISSION_MODES[number]

export const CURSOR_PERMISSION_MODES = ['default', 'plan', 'ask', 'debug', 'yolo'] as const
export type CursorPermissionMode = typeof CURSOR_PERMISSION_MODES[number]

export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'plan',
    'ask',
    'debug',
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

export type SteeringModeOption = {
    mode: SteeringMode
    label: string
}

export const STEERING_MODE_LABELS: Record<SteeringMode, string> = {
    queue: 'Queue until turn ends',
    steer: 'Steer mid-turn'
}

/**
 * Flavors whose runtime can deliver a message into a running turn without a
 * hard interrupt. Only Codex (app-server `turn/steer`) today.
 */
export const STEERING_SUPPORTED_FLAVORS = ['codex'] as const

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

export function getSteeringModeLabel(mode: SteeringMode): string {
    return STEERING_MODE_LABELS[mode]
}

export function isSteeringSupportedForFlavor(flavor?: string | null): boolean {
    return STEERING_SUPPORTED_FLAVORS.includes(flavor as typeof STEERING_SUPPORTED_FLAVORS[number])
}

export function getSteeringModeOptionsForFlavor(flavor?: string | null): SteeringModeOption[] {
    if (!isSteeringSupportedForFlavor(flavor)) {
        return []
    }
    return STEERING_MODES.map((mode) => ({
        mode,
        label: getSteeringModeLabel(mode)
    }))
}
