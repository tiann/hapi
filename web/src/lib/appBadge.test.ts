import { describe, expect, it, vi } from 'vitest'
import { getBadgeCountFromPushPayload, getTotalUnreadCountFromSessions, updateAppBadge } from './appBadge'

describe('app badge helpers', () => {
    it('prefers total unread count from push payload data', () => {
        expect(getBadgeCountFromPushPayload({
            title: 'Task needs attention',
            body: 'Session stopped',
            data: { unreadCount: 2, totalUnreadCount: 5 }
        })).toBe(5)
    })

    it('falls back to per-session unread count when total count is absent', () => {
        expect(getBadgeCountFromPushPayload({
            title: 'Ready for input',
            body: 'Agent is waiting',
            data: { unreadCount: 3 }
        })).toBe(3)
    })

    it('sums unread counts from session summaries', () => {
        expect(getTotalUnreadCountFromSessions([
            { unreadCount: 2 },
            { unreadCount: 0 },
            { unreadCount: 4 }
        ])).toBe(6)
    })

    it('sets a numeric badge for positive unread counts', async () => {
        const badgeTarget = {
            setAppBadge: vi.fn().mockResolvedValue(undefined),
            clearAppBadge: vi.fn().mockResolvedValue(undefined)
        }

        await updateAppBadge(badgeTarget, 4)

        expect(badgeTarget.setAppBadge).toHaveBeenCalledWith(4)
        expect(badgeTarget.clearAppBadge).not.toHaveBeenCalled()
    })

    it('clears the badge when unread count is zero', async () => {
        const badgeTarget = {
            setAppBadge: vi.fn().mockResolvedValue(undefined),
            clearAppBadge: vi.fn().mockResolvedValue(undefined)
        }

        await updateAppBadge(badgeTarget, 0)

        expect(badgeTarget.clearAppBadge).toHaveBeenCalled()
        expect(badgeTarget.setAppBadge).not.toHaveBeenCalled()
    })

    it('does nothing when the browser does not support app badges', async () => {
        await expect(updateAppBadge({}, 7)).resolves.toBe(false)
    })
})
