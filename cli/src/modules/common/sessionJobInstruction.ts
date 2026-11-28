/**
 * Always-on steer for session-attached long-running jobs (tiann/hapi#1404).
 *
 * Injected into flavors that have a HAPI system / developer-instructions seam
 * today: Claude, Codex, OpenCode, Grok. Cursor/Kimi/Copilot/Pi get the same
 * MCP tool (`session_job`) via the HAPI MCP bridge — catalog discovery, not
 * this prompt block. Estate skill remains a Cursor backup.
 */

/** Always-on pointer. The full gate lives in `SESSION_JOB_GATE` (tool description and `hapi job --help`). */
export const SESSION_JOB_INSTRUCTION =
    'Session jobs (`hapi job run`): default is NOT to use them; only for a process that must outlive your turn, never tests or builds. See `hapi job --help`.'

/** Append instruction to an existing prompt block (blank line separator). */
export function withSessionJobInstruction(base: string): string {
    const trimmed = base.trimEnd()
    return trimmed.length > 0
        ? `${trimmed}\n\n${SESSION_JOB_INSTRUCTION}`
        : SESSION_JOB_INSTRUCTION
}
