import type { PermissionMode } from '@hapi/protocol'

/**
 * The modes the web calls YOLO (the New Session form's "Bypass approvals and
 * sandbox"): the agent approves its own tool calls instead of asking. Which
 * calls `safe-yolo` still asks about depends on the agent; the form counts it
 * as YOLO too, and so does everything that warns about an unattended run.
 */
const YOLO_STYLE_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
    'yolo',
    'safe-yolo',
    'bypassPermissions',
    'always-proceed'
])

export function isYoloStylePermissionMode(mode: PermissionMode): boolean {
    return YOLO_STYLE_PERMISSION_MODES.has(mode)
}
