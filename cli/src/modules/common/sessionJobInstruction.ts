/**
 * Always-on steer for session-attached long-running jobs (tiann/hapi#1404).
 *
 * Injected into flavors that have a HAPI system / developer-instructions seam
 * today: Claude, Codex, OpenCode, Grok. Cursor ACP has no such seam (estate
 * skill `hapi-session-jobs` + `hapi job --help` instead). Other ACP flavors
 * (Kimi, Copilot, Pi, …) do not receive this block until an MCP job tool or
 * per-flavor seam lands — do not claim "every flavor."
 */

/** Canonical one-block contract. Keep short — every session's prompt budget. */
export const SESSION_JOB_INSTRUCTION = [
    'Session-attached jobs (outliving work):',
    'When you start work that will keep running after this agent goes idle',
    '(batch imports, long scripts, external daemons), attach it so the session',
    'list can show progress while you are idle.',
    'Prefer: hapi job run "$HAPI_SESSION_ID" <job-key> --label <text> -- <cmd>…',
    '(auto-heartbeats + marks completed/failed on exit).',
    'Manual path: hapi job set … then a wrapper must heartbeat via',
    'hapi job update at least every ~10 minutes — an idle agent cannot.',
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
