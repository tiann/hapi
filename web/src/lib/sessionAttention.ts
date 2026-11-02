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
