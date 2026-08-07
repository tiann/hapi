/**
 * Always-on steer for session-attached long-running jobs (tiann/hapi#1404).
 *
 * Unlike the session-summary contract (opt-in), this is short and triggers only
 * when the agent spawns outliving work — so it rides every supported flavor's
 * system / developer instructions by default.
 *
 * Cursor ACP has no system-prompt seam today; Cursor agents rely on the estate
 * skill `hapi-session-jobs` (and `hapi job --help`) instead.
 */

/** Canonical one-block contract. Keep short — every session's prompt budget. */
export const SESSION_JOB_INSTRUCTION = [
    'Session-attached jobs (outliving work):',
    'When you start work that will keep running after this agent goes idle',
    '(nohup, batch imports, long scripts, external daemons), attach it to this',
    'HAPI session so the session list can show progress while you are idle.',
    'Use: hapi job set "$HAPI_SESSION_ID" <job-key> --label <text>',
    '[--remaining N] [--done N --total N] [--unit <name>] [--detail <stage>].',
    'Heartbeat with hapi job update at least every ~10 minutes (UI goes amber',
    'after ~15m without a heartbeat). Prefer honest remaining or done+total;',
    'omit counts when unknown (UI shows "running" + indeterminate bar).',
    'Never invent a fake percent. On finish: hapi job update … --status',
    'completed|failed, or hapi job clear. Full contract: hapi job --help.'
].join(' ')

/** Append instruction to an existing prompt block (blank line separator). */
export function withSessionJobInstruction(base: string): string {
    const trimmed = base.trimEnd()
    return trimmed.length > 0
        ? `${trimmed}\n\n${SESSION_JOB_INSTRUCTION}`
        : SESSION_JOB_INSTRUCTION
}
