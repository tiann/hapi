import type { SessionSummary } from '@/types/api'
import type { PushPayload } from './pushNotification'

export type AppBadgeTarget = {
    setAppBadge?: (contents?: number) => Promise<void> | void
    clearAppBadge?: () => Promise<void> | void
}

function normalizeBadgeCount(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null
    }
    return Math.max(0, Math.floor(value))
}

export function getBadgeCountFromPushPayload(payload: PushPayload): number | null {
    return normalizeBadgeCount(payload.data?.totalUnreadCount)
        ?? normalizeBadgeCount(payload.data?.unreadCount)
}

export function getTotalUnreadCountFromSessions(
    sessions: Array<Pick<SessionSummary, 'unreadCount'>>
): number {
    return sessions.reduce((sum, session) => sum + Math.max(0, Math.floor(session.unreadCount ?? 0)), 0)
}

export function getBrowserAppBadgeTarget(): AppBadgeTarget | null {
    if (typeof navigator === 'undefined') {
        return null
    }
    return navigator as unknown as AppBadgeTarget
}

export async function updateAppBadge(
    target: AppBadgeTarget | null | undefined,
    count: number | null | undefined
): Promise<boolean> {
    if (!target) {
        return false
    }

    const badgeCount = normalizeBadgeCount(count)
    if (badgeCount === null) {
        return false
    }

    try {
        if (badgeCount > 0) {
            if (typeof target.setAppBadge !== 'function') {
                return false
            }
            await target.setAppBadge(badgeCount)
            return true
        }

        if (typeof target.clearAppBadge === 'function') {
            await target.clearAppBadge()
            return true
        }

        if (typeof target.setAppBadge === 'function') {
            await target.setAppBadge(0)
            return true
        }
    } catch (error) {
        console.warn('Failed to update app badge:', error)
    }

    return false
}
