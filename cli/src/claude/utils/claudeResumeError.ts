/**
 * Classify Claude launch failures so the remote launcher can tell apart
 * transient errors (worth retrying) from unrecoverable ones (retrying can only
 * loop forever).
 *
 * The motivating case: resuming a session that is still held open by a running
 * agent makes claude exit 1 with
 *   "Session <id> is currently running as a background agent (bg). Use claude
 *    agents to find and attach to it, or add --fork-session to branch off a
 *    copy."
 * Retrying that verbatim never succeeds, so it must stop the retry loop.
 *
 * Matching is intentionally loose (substrings, not exact text) so it keeps
 * working if claude's wording drifts across versions; the launcher also caps
 * total retries as a second line of defense (see MAX_LAUNCH_RETRIES).
 */

const UNRECOVERABLE_RESUME_MESSAGE_PATTERNS: string[] = [
    'currently running as a background agent',
    'currently running as an interactive',
    '--fork-session to branch off',
    'is currently running'
]

/**
 * True when `error`'s message indicates the resume target is occupied / the
 * request was rejected in a way that re-running identical args cannot fix.
 */
export function isUnrecoverableClaudeResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    const lower = message.toLowerCase()
    return UNRECOVERABLE_RESUME_MESSAGE_PATTERNS.some((pattern) => lower.includes(pattern))
}
