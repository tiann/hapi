import type { ClaudePermissionMode } from '@hapi/protocol/types'
import { CLAUDE_PERMISSION_MODES } from '@hapi/protocol/modes'

/**
 * Reverse-sync of the PTY permission mode: when the user changes claude's mode
 * directly in the terminal (Shift+Tab cycles auto → acceptEdits → plan), claude
 * reports the new mode in every PreToolUse hook payload. This maps that reported
 * mode back to the hapi session mode so the Chat UI (the primary control/display
 * channel) stays consistent with the terminal.
 *
 * Returns the new mode to apply, or `null` when nothing should change.
 *
 * yolo (`bypassPermissions`) is deliberately hapi-only: claude can't represent
 * it (it isn't in claude's Shift+Tab cycle), so a yolo session must NOT be pulled
 * out of yolo by claude's reported mode. yolo is set/cleared only from the Chat UI.
 *
 * @param current     the hapi session's current permission mode
 * @param claudeMode  the `permission_mode` claude reported in the hook payload
 */
export function computeBackSyncedPermissionMode(
    current: ClaudePermissionMode,
    claudeMode: string | undefined
): ClaudePermissionMode | null {
    if (!claudeMode) {
        return null
    }
    // Don't let claude's (non-yolo) mode clobber a yolo session.
    if (current === 'bypassPermissions') {
        return null
    }
    if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(claudeMode)) {
        return null
    }
    const next = claudeMode as ClaudePermissionMode
    // Guard: an inbound hook must never flip us into yolo.
    if (next === 'bypassPermissions') {
        return null
    }
    return next === current ? null : next
}
