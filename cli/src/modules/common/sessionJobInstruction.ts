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
    'Session-attached jobs: default is NOT to use them.',
    'Only for a process that must keep running after this agent goes idle and that the operator',
    'would reopen the chat to ask about (hours-long batch, nohup script, daemon you own).',
    'Never for anything that finishes within this turn: tests, builds, installs, typechecks, git, short scripts.',
    'If unsure, do not attach.',
    'To attach: Shell `hapi job run <session-id> <job-key> --label <text> --progress unknown -- <cmd>`',
    '(use the /sessions/<id> uuid of this chat). Run `hapi job --help` for other modes and rules.',
    'Do not pass --wake-on-terminal unless the operator asked to be woken.',
    'If you attached a job, clear or fail it yourself when its process is gone.'
].join(' ')

/** Append instruction to an existing prompt block (blank line separator). */
export function withSessionJobInstruction(base: string): string {
    const trimmed = base.trimEnd()
    return trimmed.length > 0
        ? `${trimmed}\n\n${SESSION_JOB_INSTRUCTION}`
        : SESSION_JOB_INSTRUCTION
}
