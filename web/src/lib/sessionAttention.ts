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

/**
 * Blocked state from a live prompt the operator can clear in one click.
 *
 * Returns null when nothing is pending, or when every outstanding prompt
 * predates the operator's acknowledgement.
 */
function getPendingBlockedState(
    summary: SessionSummary,
    ackAt: number | null,
    now: number
): SessionBlockedState | null {
    const kinds = Array.isArray(summary.pendingRequestKinds) ? summary.pendingRequestKinds : []
    // `pendingRequestsCount` is the authoritative total; a count without kinds
    // still parks the agent on a prompt, so do not drop it from the list.
    const total = summary.pendingRequestsCount ?? 0
    const all = summary.pendingRequests ?? []
    if (kinds.length === 0 && total === 0) {
        return null
    }

    // Acknowledged prompts drop out BEFORE the kind contest below. Picking the
    // kind first and filtering second discards a newly arrived permission
    // whenever an older, already-dismissed question still outranks it — the
    // session would vanish from the count with a live prompt unanswered.
    const unacked = ackAt === null ? all : all.filter(request => request.since > ackAt)

    // `pendingRequests` is capped and keeps the OLDEST entries, so a slice that
    // is entirely acknowledged says nothing about newer prompts the summary
    // never carried. `pendingRequestsNewestAt` is computed uncapped for exactly
    // this question; without it (older hub) fall back to what we can see.
    const newestAt = summary.pendingRequestsNewestAt
        ?? (all.length > 0 ? all[all.length - 1]!.since : 0)
    const newerBeyondCap = total > all.length && newestAt > (ackAt ?? 0)
    if (ackAt !== null && unacked.length === 0 && !newerBeyondCap) {
        return null
    }

    // A question outranks a permission: "answer me" is a heavier ask than
    // "approve this tool", and it is the one the operator asked to be loud.
    // Contest only what still needs answering; fall back to the uncapped kind
    // list when the capped slice carries none of it.
    const unackedKinds = unacked.map(request => request.kind)
    const contest = unackedKinds.length > 0 ? unackedKinds : kinds
    const reason: SessionBlockedReason = contest.includes('input') ? 'question' : 'permission'

    const wantedKind = reason === 'question' ? 'input' : 'permission'
    // `unacked` is oldest-first, so the first match is the oldest of its kind.
    const oldest = unacked.find(request => request.kind === wantedKind) ?? unacked[0] ?? null
    const at = oldest?.since ?? (newestAt > 0 ? newestAt : summary.updatedAt)

    return {
        reason,
        at,
        note: oldest?.tool ?? null,
        stale: now - at > BLOCKED_NOTIFY_STALE_MS
    }
}

export function getSessionBlockedState(
    summary: SessionSummary,
    options: { now: number }
): SessionBlockedState | null {
    // Operator dismissed this by hand. A watermark, not a flag: a blocker
    // reported AFTER the acknowledgement is a genuinely new problem and must
    // come back, or "mark unblocked" would silently mute the session forever.
    // Null rather than 0: a 0 sentinel would dismiss any blocker whose
    // timestamp is non-positive, which is only ever a test or clock artefact
    // but is exactly the kind of silent suppression this feature must not do.
    const ackAt = summary.blockedAck?.at ?? null

    // Live prompts are read BEFORE the `thinking` guard below, deliberately. A
    // remote Claude agent keeps `thinking` true while it waits on a permission
    // or a question — the SDK only clears it on the turn's result, and the
    // permission handler never touches it — so guarding first would hide the
    // single most common blocker this feature exists to surface, for the whole
    // duration of the wait. `classifySessionAttention` likewise reports a
    // pending request regardless of `thinking`.
    const pending = getPendingBlockedState(summary, ackAt, options.now)
    if (pending !== null) {
        return pending
    }

    // A working agent is not self-reporting blocked: the stored footer is a
    // point-in-time claim from a turn that has since been superseded, and
    // nothing is waiting on the operator. Also covers the window before the
    // hub's clear-on-new-turn patch lands.
    if (summary.thinking) {
        return null
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
