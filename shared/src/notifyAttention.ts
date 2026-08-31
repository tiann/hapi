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
 * Notify statuses that mean "a human is needed before this can continue".
 *
 * Deliberately wider than the documented contract vocabulary, because agents
 * emit synonyms in practice. Measured on a 683-session fleet: `pending` (92)
 * and `completed` (2) both occur and neither is in the contract. Treating an
 * unrecognised status as blocking would cry wolf, and treating `pending` as
 * unrecognised would miss the single most common waiting signal there is.
 */
export const BLOCKING_NOTIFY_STATUSES: readonly string[] = [
    'blocked',
    // Self-reported stuck; the hub's work_ad mapping already folds this to blocked.
    'stalled',
    // "There is a question that needs answering" / "I need a call from you".
    'needs_decision',
    'needs_review',
    'awaiting_review',
    // Errors are blockers too — nothing proceeds until someone looks.
    'failed',
    'error',
    // Not in the contract, but the most-emitted waiting status in the wild.
    'pending',
    'waiting',
    'needs_input',
    'blocked_on_operator'
]

/**
 * Statuses that explicitly mean "no human needed". Kept separate from
 * "unrecognised" so a new synonym for done cannot start alarming, and so
 * `completed` (non-contract, observed) clears a prior blocked report.
 */
export const NON_BLOCKING_NOTIFY_STATUSES: readonly string[] = [
    'done',
    'completed',
    'complete',
    'success',
    'ok',
    'in_progress',
    'running',
    'started',
    'stale'
]

/** Back-compat alias: the original narrow set. Prefer BLOCKING_NOTIFY_STATUSES. */
export const BLOCKED_NOTIFY_STATUSES: readonly string[] = ['blocked', 'stalled']

/**
 * How a blocking status should be presented. Collapses synonyms onto the small
 * set of chips the session list actually draws.
 */
export type NotifyBlockReason = 'blocked' | 'stalled' | 'needs_decision' | 'needs_review' | 'failed'

const NOTIFY_BLOCK_REASON: Record<string, NotifyBlockReason> = {
    blocked: 'blocked',
    pending: 'blocked',
    waiting: 'blocked',
    needs_input: 'blocked',
    blocked_on_operator: 'blocked',
    stalled: 'stalled',
    needs_decision: 'needs_decision',
    needs_review: 'needs_review',
    awaiting_review: 'needs_review',
    failed: 'failed',
    error: 'failed'
}

export function getNotifyBlockReason(status: string | null | undefined): NotifyBlockReason | null {
    const normalized = normalizeNotifyStatus(status)
    if (normalized === '' || !BLOCKING_NOTIFY_STATUSES.includes(normalized)) return null
    return NOTIFY_BLOCK_REASON[normalized] ?? 'blocked'
}

export function isNonBlockingNotifyStatus(status: string | null | undefined): boolean {
    return NON_BLOCKING_NOTIFY_STATUSES.includes(normalizeNotifyStatus(status))
}

/**
 * How long blocked chrome stays loud. Past this a row demotes to a muted
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
    return getNotifyBlockReason(status) !== null
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
