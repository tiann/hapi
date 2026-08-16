/**
 * Optional session-status summary instruction for non-Cursor agent flavors.
 *
 * Cursor ACP has no system-prompt / rules-overlay seam in upstream today, so
 * it is intentionally not covered here. Claude / Codex / OpenCode / Grok get
 * this text via their existing system-prompt / developer-instructions /
 * one-shot instruction paths when the operator opts in.
 *
 * Resolution order:
 * 1. Explicit `HAPI_SESSION_SUMMARY_CONTRACT` env (0|false|off|no → off; anything else → on)
 * 2. Hub preference applied via `applyHubSessionSummaryContract` (from session bootstrap)
 * 3. Default: off (matches A2A RFC — emission stays optional indefinitely)
 */

let hubPreference: boolean | undefined

/** Apply the hub-resolved toggle from session create/get bootstrap. */
export function applyHubSessionSummaryContract(enabled: boolean): void {
    hubPreference = enabled
}

/** Test-only: clear hub preference between cases. */
export function resetSessionSummaryContractForTests(): void {
    hubPreference = undefined
}

export function isSessionSummaryContractEnabled(
    env: NodeJS.ProcessEnv = process.env
): boolean {
    const raw = env.HAPI_SESSION_SUMMARY_CONTRACT
    if (raw !== undefined && raw !== '') {
        const normalized = raw.trim().toLowerCase()
        return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no')
    }
    return hubPreference === true
}

/**
 * Canonical trailing-line contract. Matches the FCM / native-companion parser
 * in `@hapi/protocol` (`extractNotifySummary`).
 */
export const SESSION_SUMMARY_CONTRACT_LINE =
    'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"<agent-id>","project":"<project>","status":"done|blocked|needs_review|needs_decision|failed|stalled","action":"<=12 words","summary":"one-line triage"}'

/**
 * Body appended to flavor system / developer instructions when enabled.
 * Keep short — rides every session's prompt budget.
 */
export function buildSessionSummaryInstruction(): string {
    return [
        'Session status summary:',
        'End every response with a single machine-readable status line (no backticks)',
        'so this workspace\'s session tracking can record progress. Put it on its own',
        'final line after all other content:',
        SESSION_SUMMARY_CONTRACT_LINE,
        'Use the language used by the user in the current conversation for the',
        'human-readable "action" and "summary" values.',
        'Use status "blocked" if unsure. Keep action to 12 words or fewer when status',
        'is "done" and follow-up remains.'
    ].join('\n')
}

/** Empty string when disabled so callers can append unconditionally. */
export function sessionSummaryInstructionOrEmpty(
    env: NodeJS.ProcessEnv = process.env
): string {
    return isSessionSummaryContractEnabled(env) ? buildSessionSummaryInstruction() : ''
}

/** Append instruction to an existing prompt block (blank line separator). */
export function withSessionSummaryInstruction(
    base: string,
    env: NodeJS.ProcessEnv = process.env
): string {
    const extra = sessionSummaryInstructionOrEmpty(env)
    if (!extra) return base
    const trimmed = base.trimEnd()
    return trimmed.length > 0 ? `${trimmed}\n\n${extra}` : extra
}
