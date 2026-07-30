import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAbsoluteDateTime, formatRelativeTime, formatSessionListDate } from '@/lib/relativeTime'

type TFunc = (key: string, params?: Record<string, string | number>) => string

const t: TFunc = (key, params) => {
    if (!params) return key
    let s = key
    for (const [k, v] of Object.entries(params)) {
        s = s.replaceAll(`{${k}}`, String(v))
    }
    return s
}

afterEach(() => {
    vi.useRealTimers()
})

describe('formatSessionListDate', () => {
    it('zero-pads months and days', () => {
        expect(formatSessionListDate(new Date(2026, 6, 7))).toBe('2026/07/07')
    })
})

describe('formatRelativeTime', () => {
    const NOW = new Date('2026-06-13T17:00:00Z').getTime()

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(NOW))
    })

    it('returns just-now bucket for sub-minute deltas', () => {
        expect(formatRelativeTime(NOW - 30_000, t)).toBe('session.time.justNow')
        expect(formatRelativeTime(NOW - 59_000, t)).toBe('session.time.justNow')
    })

    it('returns minutes bucket for sub-hour deltas', () => {
        expect(formatRelativeTime(NOW - 5 * 60_000, t)).toBe('session.time.minutesAgo')
        expect(formatRelativeTime(NOW - 5 * 60_000, ((key, params) => {
            return `${key}:${params?.n ?? ''}`
        }) as TFunc)).toBe('session.time.minutesAgo:5')
    })

    it('returns hours bucket for sub-day deltas', () => {
        expect(formatRelativeTime(NOW - 3 * 60 * 60_000, ((key, params) => {
            return `${key}:${params?.n ?? ''}`
        }) as TFunc)).toBe('session.time.hoursAgo:3')
    })

    it('returns days bucket for sub-week deltas', () => {
        expect(formatRelativeTime(NOW - 4 * 24 * 60 * 60_000, ((key, params) => {
            return `${key}:${params?.n ?? ''}`
        }) as TFunc)).toBe('session.time.daysAgo:4')
    })

    it('falls back to the padded session-list date for >= 1 week', () => {
        const tenDaysAgo = NOW - 10 * 24 * 60 * 60_000
        const out = formatRelativeTime(tenDaysAgo, t)
        expect(out).toBe(formatSessionListDate(new Date(tenDaysAgo)))
    })

    it('uses the padded date after the relative-time window', () => {
        vi.setSystemTime(new Date(2026, 6, 21, 12, 0))
        expect(formatRelativeTime(new Date(2026, 6, 7, 9, 0).getTime(), t)).toBe('2026/07/07')
    })

    it('treats Unix-second timestamps the same as ms (auto-detect)', () => {
        const secs = Math.floor((NOW - 30_000) / 1000)
        expect(formatRelativeTime(secs, t)).toBe('session.time.justNow')
    })

    it('returns null for non-finite values', () => {
        expect(formatRelativeTime(Number.NaN, t)).toBeNull()
        expect(formatRelativeTime(Number.POSITIVE_INFINITY, t)).toBeNull()
    })
})

describe('formatAbsoluteDateTime', () => {
    it('returns a non-null string for finite ms timestamps', () => {
        const out = formatAbsoluteDateTime(new Date('2026-06-13T17:00:00Z').getTime())
        expect(out).not.toBeNull()
        expect(typeof out).toBe('string')
    })

    it('returns null for non-finite values', () => {
        expect(formatAbsoluteDateTime(Number.NaN)).toBeNull()
        expect(formatAbsoluteDateTime(Number.POSITIVE_INFINITY)).toBeNull()
    })
})
