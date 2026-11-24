import { z } from 'zod'
import { AGENT_FLAVORS, Flavors, getPermissionModesForFlavor, type PermissionModeOf } from './flavors'

// Re-exported for importers of '@hapi/protocol/modes'.
export {
    AGENT_FLAVORS,
    CREATABLE_AGENT_FLAVORS,
    Flavors,
    STEERING_SUPPORTED_FLAVORS,
    getPermissionModesForFlavor,
    hasActiveSteeringTurn,
    isPermissionModeAllowedForFlavor,
    isSteeringSupportedForFlavor,
    isSteeringSupportedForSession
} from './flavors'
export type { AgentFlavor, PermissionModeOf } from './flavors'

/**
 * @description The legacy payload type identifier used for all generic agent messages.
 * Changing this value will affect the communication schema between CLI, Hub, and Web.
 * A migration plan is required if this literal is ever modified.
 */
export const AGENT_MESSAGE_PAYLOAD_TYPE = 'codex' as const

export const AgentFlavorSchema = z.enum(AGENT_FLAVORS)

export const CODEX_COLLABORATION_MODES = ['default', 'plan'] as const
export type CodexCollaborationMode = typeof CODEX_COLLABORATION_MODES[number]

export const HERMES_PERMISSION_MODES = Flavors.hermes.permissionModes
export type HermesPermissionMode = PermissionModeOf<typeof Flavors.hermes>

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
    'yolo',
    'request-review',
    'always-proceed'
] as const
export type PermissionMode = typeof PERMISSION_MODES[number]


export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    auto: 'Auto',
    plan: 'Plan Mode',
    ask: 'Ask Mode',
    debug: 'Debug Mode',
    autoReview: 'Auto',
    bypassPermissions: 'Yolo',
    'read-only': 'Read Only',
    'safe-yolo': 'Safe Yolo',
    yolo: 'Yolo',
    'request-review': 'Request Review',
    'always-proceed': 'Always Proceed'
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
    yolo: 'danger',
    'request-review': 'neutral',
    'always-proceed': 'danger'
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

export function getPermissionModeOptionsForFlavor(flavor?: string | null): PermissionModeOption[] {
    return getPermissionModesForFlavor(flavor).map((mode) => ({
        mode,
        label: getPermissionModeLabel(mode),
        tone: getPermissionModeTone(mode)
    }))
}

export function getCodexCollaborationModeOptions(): CodexCollaborationModeOption[] {
    return CODEX_COLLABORATION_MODES.map((mode) => ({
        mode,
        label: getCodexCollaborationModeLabel(mode)
    }))
}

export type SteeringSessionMetadata = {
    flavor?: string | null
    cursorSessionId?: string | null
    cursorSessionProtocol?: 'acp' | 'stream-json' | null
    agyProtocol?: 'acp' | null
}

export type SteeringSessionState = {
    metadata?: SteeringSessionMetadata | null
    thinking?: boolean
    agentState?: { steeringActive?: boolean | null } | null
}

export type SteeringCapability = {
    activeTurnState: 'thinking' | 'steeringActive'
    supportsSession?: (metadata: SteeringSessionMetadata) => boolean
}
