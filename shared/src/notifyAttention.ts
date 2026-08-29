/**
 * Blocked-agent attention derived from the agent's `AGENT_NOTIFY_SUMMARY`
 * footer (see `extractNotifySummary` in `./messages`).
 *
 * This is a distinct axis from `SessionAttention` (permission / input /
 * background / unread): those describe a session that is *live and waiting on
 * a click*, this describes a turn that *ended* with the agent declaring it
 * cannot proceed. Both can be true at once, so they never contend — the web
 * list renders them in different visual channels.
 */

/** Note (`action`, else `summary`) carried onto the session list for tooltips. */
export const NOTIFY_NOTE_MAX_CHARS = 160

/**
 * Statuses that mean "the agent stopped and needs a human".
 *
 * Mirrors the hub's existing `mapNotifyStatusToWorkAdStatus` fold, where a
 * self-reported `stalled` ("I believe I am stuck") is also `blocked`.
 * `needs_decision` / `needs_review` / `failed` are deliberately excluded from
 * this first cut — they warrant their own treatment rather than being folded
 * into the blocked rail.
 */
export const BLOCKED_NOTIFY_STATUSES: readonly string[] = ['blocked', 'stalled']

/**
 * How long blocked chrome stays loud. Past this the row demotes to a muted
 * variant (still counted, still filterable) so an abandoned session does not
 * hold a permanent alarm. Matches the work-graph work_ad default TTL.
 */
export const BLOCKED_NOTIFY_STALE_MS = 24 * 60 * 60 * 1000

/** Last `AGENT_NOTIFY_SUMMARY` footer seen for a session. */
export type SessionNotifySignal = {
    /** Raw self-reported status, lowercased. Kept verbatim so new vocabulary
     *  survives a hub older than the agent emitting it. */
    status: string
    /** Epoch ms of the message carrying the footer. */
    at: number
    /** Short operator-facing hint; only stored for blocked statuses. */
    note: string | null
}

export function normalizeNotifyStatus(status: string | null | undefined): string {
    return typeof status === 'string' ? status.trim().toLowerCase() : ''
}

export function isBlockedNotifyStatus(status: string | null | undefined): boolean {
    return BLOCKED_NOTIFY_STATUSES.includes(normalizeNotifyStatus(status))
}

export function clampNotifyNote(note: string | null | undefined): string | null {
    if (typeof note !== 'string') return null
    const trimmed = note.trim()
    if (trimmed.length === 0) return null
    return trimmed.length <= NOTIFY_NOTE_MAX_CHARS
        ? trimmed
        : `${trimmed.slice(0, NOTIFY_NOTE_MAX_CHARS - 1)}…`
}

/**
 * Pick the operator-facing note from a notify footer.
 * `action` ("what remains", <=12 words) is more actionable than the prose
 * `summary`, so it wins when present.
 */
export function pickNotifyNote(
    footer: { action?: string; summary?: string }
): string | null {
    return clampNotifyNote(footer.action) ?? clampNotifyNote(footer.summary)
}
