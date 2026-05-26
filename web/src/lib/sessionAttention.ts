import type { SessionSummary } from '@/types/api'

export type SessionAttention =
    | { kind: 'permission' }
    | { kind: 'input' }
    | { kind: 'background' }
    | { kind: 'unread' }

export function classifySessionAttention(
    summary: SessionSummary,
    options: { selected: boolean; lastSeenAt: number }
): SessionAttention | null {
    if (options.selected || !summary.active || summary.thinking) {
        return null
    }

    if (summary.pendingRequestKinds.includes('permission')) {
        return { kind: 'permission' }
    }

    if (summary.pendingRequestKinds.includes('input')) {
        return { kind: 'input' }
    }

    if (summary.backgroundTaskCount > 0) {
        return { kind: 'background' }
    }

    if (summary.updatedAt > options.lastSeenAt) {
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
