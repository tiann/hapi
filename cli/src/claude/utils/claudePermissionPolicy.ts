import type { PermissionMode } from '@hapi/protocol/types'
import { getToolDescriptor } from './getToolDescriptor'
import { isQuestionToolName } from './questionAnswerInput'

/**
 * Outcome of the shared, mode-based claude permission policy.
 *  - `allow`       — auto-approve without asking the user.
 *  - `web`         — must be surfaced in the web UI (never auto-approved).
 *  - `fallthrough` — no mode-based decision; the caller applies its own
 *                    remaining rules (session allow-lists, read-only tools,
 *                    the approval modal, ...).
 */
export type ClaudeModePolicy = 'allow' | 'web' | 'fallthrough'

/**
 * The mode-based slice of claude's permission decision for the PTY PreToolUse
 * hook path. Modelled on the SDK `canCallTool` handler (permissionHandler.ts),
 * which keeps its own inline copy of these rules — adopting this helper there is
 * a separate change, out of scope for the PTY work — so any rule change here
 * should be mirrored in permissionHandler.ts.
 *
 * Rules, in order:
 *  1. Question tools (AskUserQuestion / request_user_input) ALWAYS go to the
 *     web, in every mode. Auto-allowing them would make the SDK stall or the
 *     PTY render its interactive selector only — the question would never
 *     reach the chat.
 *  2. bypassPermissions (the --yolo mapping) auto-allows everything else.
 *  3. acceptEdits auto-allows edit tools (Edit/Write/MultiEdit/NotebookEdit).
 *
 * Everything else is `fallthrough`: the caller decides (default mode, plan
 * mode, session allow-lists, etc.).
 *
 * Known divergence from the SDK: under bypassPermissions the SDK special-cases
 * `exit_plan_mode` (injects PLAN_FAKE_RESTART and denies, so the SDK turn
 * continues past the plan). This helper returns `allow` for it instead — in PTY
 * mode claude drives its own plan exit interactively, so the SDK's queue-
 * injection trick doesn't apply. Callers that need that behaviour must handle
 * `exit_plan_mode` before consulting this helper (the SDK path still does).
 */
export function resolveClaudeModePolicy(
    mode: PermissionMode | undefined,
    toolName: string
): ClaudeModePolicy {
    if (isQuestionToolName(toolName)) {
        return 'web'
    }
    if (mode === 'bypassPermissions') {
        return 'allow'
    }
    if (mode === 'acceptEdits' && getToolDescriptor(toolName).edit) {
        return 'allow'
    }
    return 'fallthrough'
}
