/**
 * Always-on steer for session-attached long-running jobs (tiann/hapi#1404).
 *
 * Injected into flavors that have a HAPI system / developer-instructions seam
 * today: Claude, Codex, OpenCode, Grok. Cursor/Kimi/Copilot/Pi get the same
 * MCP tool (`session_job`) via the HAPI MCP bridge — catalog discovery, not
 * this prompt block. Estate skill remains a Cursor backup.
 */

/** Canonical one-block contract. Keep short — every session's prompt budget. */
export const SESSION_JOB_INSTRUCTION = [
    'Session-attached jobs (outliving work):',
    'When you start work that will keep running after this agent goes idle',
    '(batch imports, long scripts, external daemons), attach a session job so',
    'the session list shows progress while you are idle — same class of HAPI',
    'tooling as ping_peer / inspect_peer.',
    'REQUIRED for process-shaped work (idle agents cannot heartbeat):',
    'Shell → hapi job run "$HAPI_SESSION_ID" <job-key> --label <text> -- <cmd>…',
    '(auto-heartbeats + completed/failed on exit).',
    'Do NOT use MCP session_job action=set (refused) or bare set+nohup — that freezes the bar.',
    'MCP session_job is only update / clear / list after job run created the meter.',
    'Prefer honest remaining or done+total; omit counts when unknown',
    '(UI shows "running" + elapsed). Never invent a fake percent.',
    'Full contract: hapi job --help.'
].join(' ')

/** Append instruction to an existing prompt block (blank line separator). */
export function withSessionJobInstruction(base: string): string {
    const trimmed = base.trimEnd()
    return trimmed.length > 0
        ? `${trimmed}\n\n${SESSION_JOB_INSTRUCTION}`
        : SESSION_JOB_INSTRUCTION
}
