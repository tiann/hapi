/**
 * Auto-recovery when Cursor ACP dies mid-turn after tools already ran (#1724).
 *
 * Replaying the original user prompt risks duplicate side effects. The operator
 * recovery that always works is a fresh "Continue." turn — same as tapping
 * Continue in the web UI — so the harness does that once automatically.
 */

export const CURSOR_POST_TOOL_INTERRUPT_CONTINUE = 'Continue.';

export const CURSOR_POST_TOOL_INTERRUPT_AUTO_CONTINUE_STATUS =
    'Cursor connection interrupted after tool activity; auto-continuing.';

export const CURSOR_POST_TOOL_INTERRUPT_GIVE_UP_MESSAGE =
    'Cursor connection interrupted after tool activity; auto-continue also failed.';
