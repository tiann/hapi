import { describe, expect, it } from 'vitest'
import {
    formatFutureRelativeTime,
    formatScheduledFireLabel,
    formatScheduledTime,
    formatScheduledTooltipDetail
} from './scheduledTime'

const t = (key: string, params?: Record<string, string | number>) => {
    const table: Record<string, string> = {
        'session.time.soon': 'soon',
        'session.time.inLessThanMinute': 'in <1m',
        'session.time.inMinutes': 'in {n}m',
        'session.time.inHours': 'in {n}h',
        'session.time.inDays': 'in {n}d',
        'session.tooltip.scheduled.body': 'Will fire when due.',
        'session.tooltip.scheduled.fires': 'Fires {when}',
        'session.tooltip.scheduled.next': 'Next {when} · +{more} more',
    }
    let out = table[key] ?? key
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            out = out.replace(`{${k}}`, String(v))
        }
    }
    return out
}

describe('formatFutureRelativeTime', () => {
    it('returns in-minutes countdown for near-future timestamps', () => {
        const inFive = Date.now() + 5 * 60_000
        expect(formatFutureRelativeTime(inFive, t)).toBe('in 5m')
    })

    it('returns soon for past-due timestamps', () => {
        expect(formatFutureRelativeTime(Date.now() - 1_000, t)).toBe('soon')
    })
})

describe('formatScheduledFireLabel', () => {
    it('combines relative and absolute labels', () => {
        const at = Date.now() + 5 * 60_000
        const label = formatScheduledFireLabel(at, t)
        expect(label).toContain('in 5m')
        expect(label).toContain('·')
        expect(label).toContain(formatScheduledTime(at))
    })
})

describe('formatScheduledTooltipDetail', () => {
    it('shows single scheduled fire time', () => {
        const at = Date.now() + 5 * 60_000
        const body = formatScheduledTooltipDetail({
            futureScheduledMessageCount: 1,
            nextScheduledAt: at
        }, t)
        expect(body).toMatch(/^Fires /)
        expect(body).toContain('in 5m')
    })

    it('shows next + overflow for multiple scheduled messages', () => {
        const at = Date.now() + 5 * 60_000
        const body = formatScheduledTooltipDetail({
            futureScheduledMessageCount: 3,
            nextScheduledAt: at
        }, t)
        expect(body).toContain('Next ')
        expect(body).toContain('+2 more')
    })

    it('falls back when nextScheduledAt is missing', () => {
        expect(formatScheduledTooltipDetail({
            futureScheduledMessageCount: 1,
            nextScheduledAt: null
        }, t)).toBe('Will fire when due.')
    })
})
