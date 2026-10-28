/**
 * Harness-side Blocked stamp for unexpected Cursor stop exits (#1724).
 *
 * Estate Blocked chrome (#1717) reads `lastNotify` from a real
 * `AGENT_NOTIFY_SUMMARY` footer on assistant **text**. Error-shaped chat rows
 * alone never reach that path (`extractAssistantPlainText` skips them).
 *
 * Clamping is local (not `clampNotifyNote` from protocol) so this PR does not
 * stack on the blocked-list soup layer.
 */

/** Default action when the launcher has no sharper next step. */
export const UNEXPECTED_STOP_BLOCKED_ACTION = 'Continue or investigate';

/** Matches estate note budget used by blocked-list chrome. */
const SUMMARY_MAX_CHARS = 160;

function clampNote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) return 'Unexpected stop; turn did not finish.';
    if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed;
    return `${trimmed.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

export function formatUnexpectedStopBlockedFooter(input: {
    summary: string;
    action?: string;
}): string {
    const summary = clampNote(input.summary);
    const action = clampNote(input.action ?? UNEXPECTED_STOP_BLOCKED_ACTION);
    return `AGENT_NOTIFY_SUMMARY ${JSON.stringify({
        version: 1,
        status: 'blocked',
        action,
        summary
    })}`;
}
