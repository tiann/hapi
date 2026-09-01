import {
    BLOCKED_NOTIFY_STALE_MS,
    getNotifyBlockReason
} from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { hasUnseenContent } from '@/lib/sessionLastSeen'

export type SessionAttention =
    | { kind: 'permission' }
    | { kind: 'input' }
    | { kind: 'background' }
    | { kind: 'unread' }

function hasManualUnreadMarker(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

/** True when the session has activity newer than the operator's last-seen watermark. */
export function sessionIsUnread(
    summary: SessionSummary,
    options: { lastSeenAt: number; manualUnreadAt?: number | null }
): boolean {
    const manualUnread = options.manualUnreadAt === undefined
        ? summary.readState?.manualUnread === true
        : hasManualUnreadMarker(options.manualUnreadAt)
    return manualUnread
        || hasUnseenContent(summary, Math.max(options.lastSeenAt, summary.readState?.readRevision ?? 0))
}

export function classifySessionAttention(
    summary: SessionSummary,
    options: { selected: boolean; lastSeenAt: number; manualUnreadAt?: number | null }
): SessionAttention | null {
    // Requests left on an archived session can no longer be answered.
    const pendingRequestKinds = summary.active && Array.isArray(summary.pendingRequestKinds)
        ? summary.pendingRequestKinds
        : []

    if (pendingRequestKinds.includes('permission')) {
        return { kind: 'permission' }
    }

    if (pendingRequestKinds.includes('input')) {
        return { kind: 'input' }
    }

    // Rows draw running work beside the dot, so unread wins over background.
    if (sessionIsUnread(summary, {
        lastSeenAt: options.lastSeenAt,
        manualUnreadAt: options.manualUnreadAt
    })) {
        return { kind: 'unread' }
    }

    if (summary.active && (summary.backgroundTaskCount ?? 0) > 0) {
        return { kind: 'background' }
    }

    return null
}

export function getSessionAttentionLabelKey(attention: SessionAttention): string {
    switch (attention.kind) {
        case 'permission':
            return 'session.item.permission'
        case 'input':
            return 'session.item.needsInput'
        case 'background':
            return 'session.item.background'
        case 'unread':
            return 'session.item.newActivity'
    }
}

/**
 * Blocked chrome for a session row — "this agent cannot proceed without me".
 *
 * Two sources feed it:
 *  - a self-reported `AGENT_NOTIFY_SUMMARY` footer of `blocked` / `stalled`
 *    (the turn ended and the agent said it is stuck), and
 *  - a live pending permission / input request (the agent is parked on a
 *    prompt only the operator can answer).
 *
 * Both mean the same thing to an operator scanning 600 sessions, so they share
 * one count, one section, and one row treatment — differing only in the chip's
 * reason label.
 *
 * This is still a *different channel* from `SessionAttention`: that returns the
 * per-row dot (and stays as it is), while this drives the row rail, the chip,
 * and the header counter. A row can carry both without either having to win.
 */
export type SessionBlockedReason =
    | 'blocked'
    | 'stalled'
    | 'needs_decision'
    | 'needs_review'
    | 'failed'
    | 'permission'
    | 'question'

export type SessionBlockedState = {
    reason: SessionBlockedReason
    /** Epoch ms it became blocked — footer time, or the oldest pending request. */
    at: number
    /** Short operator-facing hint: the notify note, or the awaited tool. */
    note: string | null
    /** Past the loud window — render muted so abandoned rows stop alarming. */
    stale: boolean
}

function getPendingBlockedReason(summary: SessionSummary): SessionBlockedReason | null {
    const kinds = Array.isArray(summary.pendingRequestKinds) ? summary.pendingRequestKinds : []
    // A question outranks a permission: "answer me" is a heavier ask than
    // "approve this tool", and it is the one the operator asked to be loud.
    if (kinds.includes('input')) return 'question'
    if (kinds.includes('permission')) return 'permission'
    // `pendingRequestsCount` is the authoritative total; a count without kinds
    // still parks the agent on a prompt, so do not drop it from the list.
    return (summary.pendingRequestsCount ?? 0) > 0 ? 'permission' : null
}

export function getSessionBlockedState(
    summary: SessionSummary,
    options: { now: number }
): SessionBlockedState | null {
    // A working agent is not blocked. Matches `classifySessionAttention`, which
    // also suppresses every attention kind while `thinking`, and covers the
    // window before the hub's clear-on-new-turn patch lands.
    if (summary.thinking) {
        return null
    }

    // Operator dismissed this by hand. A watermark, not a flag: a blocker
    // reported AFTER the acknowledgement is a genuinely new problem and must
    // come back, or "mark unblocked" would silently mute the session forever.
    // Null rather than 0: a 0 sentinel would dismiss any blocker whose
    // timestamp is non-positive, which is only ever a test or clock artefact
    // but is exactly the kind of silent suppression this feature must not do.
    const ackAt = summary.blockedAck?.at ?? null

    // A live prompt outranks a stored footer: it is the thing the operator can
    // clear in one click. The two rarely coexist anyway — starting a new turn
    // clears `lastNotify` hub-side.
    const pendingReason = getPendingBlockedReason(summary)
    if (pendingReason !== null) {
        const wantedKind = pendingReason === 'question' ? 'input' : 'permission'
        const all = summary.pendingRequests ?? []
        const matching = all.filter(request => request.kind === wantedKind)
        // `pendingRequests` is capped and oldest-first; fall back to the whole
        // list when the summary dropped the matching kind.
        const pool = matching.length > 0 ? matching : all
        const unacked = ackAt === null ? pool : pool.filter(request => request.since > ackAt)
        // Compare the ack against every known prompt, not just the oldest: a
        // prompt raised AFTER the acknowledgement is a new ask and must block
        // even while an older, already-dismissed prompt is still outstanding.
        const oldestUnacked = unacked[0]
        const at = oldestUnacked?.since
            ?? (pool.length === 0 ? summary.updatedAt : null)

        // Deliberately falls through rather than returning null: the prompt
        // being dismissed says nothing about a newer self-reported footer on
        // the same session, and returning here would silently mute it.
        if (at !== null && (ackAt === null || at > ackAt)) {
            return {
                reason: pendingReason,
                at,
                note: oldestUnacked?.tool ?? null,
                stale: options.now - at > BLOCKED_NOTIFY_STALE_MS
            }
        }
    }

    const notify = summary.lastNotify
    const notifyReason = notify ? getNotifyBlockReason(notify.status) : null
    if (!notify || notifyReason === null || (ackAt !== null && notify.at <= ackAt)) {
        return null
    }

    return {
        reason: notifyReason,
        at: notify.at,
        note: notify.note ?? null,
        stale: options.now - notify.at > BLOCKED_NOTIFY_STALE_MS
    }
}

export function sessionIsBlocked(summary: SessionSummary, options: { now: number }): boolean {
    return getSessionBlockedState(summary, options) !== null
}

const BLOCKED_LABEL_KEY: Record<SessionBlockedReason, string> = {
    blocked: 'sessions.blockedChip.blocked',
    stalled: 'sessions.blockedChip.stalled',
    needs_decision: 'sessions.blockedChip.decision',
    needs_review: 'sessions.blockedChip.review',
    failed: 'sessions.blockedChip.failed',
    permission: 'sessions.blockedChip.permission',
    question: 'sessions.blockedChip.question'
}

export function getSessionBlockedLabelKey(state: SessionBlockedState): string {
    return BLOCKED_LABEL_KEY[state.reason]
}

/**
 * Errors read as errors. Everything else that needs a human is amber — one
 * colour for "you are the blocker", red reserved for "it broke".
 */
export function sessionBlockedIsError(state: SessionBlockedState): boolean {
    return state.reason === 'failed'
}
