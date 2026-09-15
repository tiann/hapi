import type { SessionSummary } from '@/types/api'
import { getSessionActivityTimestamp } from '@hapi/protocol'

export type SessionAttention =
    | { kind: 'permission' }
    | { kind: 'input' }
    | { kind: 'background' }
    | { kind: 'unread' }

/** True when user-facing session activity is newer than the last-seen watermark. */
export function sessionIsUnread(
    summary: SessionSummary,
    options: { lastSeenAt: number }
): boolean {
    // Legacy rows are backfilled asynchronously. Until the Hub confirms that
    // the reply clock is complete, comparing a partial clock to the local
    // watermark could create a false historical unread dot.
    if (summary.assistantReplyClockBackfilled === false) {
        return false
    }
    return getSessionActivityTimestamp(summary) > options.lastSeenAt
}

export function classifySessionAttention(
    summary: SessionSummary,
    options: { selected: boolean; lastSeenAt: number; manualUnreadAt?: number | null }
): SessionAttention | null {
    if (options.selected) {
        return options.manualUnreadAt === getSessionActivityTimestamp(summary)
            ? { kind: 'unread' }
            : null
    }

    if (summary.thinking) {
        return null
    }

    const pendingRequestKinds = Array.isArray(summary.pendingRequestKinds)
        ? summary.pendingRequestKinds
        : []

    if (pendingRequestKinds.includes('permission')) {
        return { kind: 'permission' }
    }

    if (pendingRequestKinds.includes('input')) {
        return { kind: 'input' }
    }

    if (summary.active && (summary.backgroundTaskCount ?? 0) > 0) {
        return { kind: 'background' }
    }

    if (sessionIsUnread(summary, { lastSeenAt: options.lastSeenAt })) {
        return { kind: 'unread' }
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
