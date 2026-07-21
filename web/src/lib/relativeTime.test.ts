import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime, formatSessionListDate } from '@/lib/relativeTime'

const t = (key: string) => key

afterEach(() => {
    vi.useRealTimers()
})

describe('formatSessionListDate', () => {
    it('zero-pads months and days', () => {
        expect(formatSessionListDate(new Date(2026, 6, 7))).toBe('2026/07/07')
    })
})

describe('formatRelativeTime', () => {
    it('uses the padded date after the relative-time window', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 6, 21, 12, 0))

        expect(formatRelativeTime(new Date(2026, 6, 7, 9, 0).getTime(), t)).toBe('2026/07/07')
    })
})
