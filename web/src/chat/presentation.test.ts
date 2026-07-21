import { describe, expect, it } from 'vitest'
import { getEventPresentation, formatMessageTimestamp, formatResetTime } from './presentation'

describe('getEventPresentation — agent errors', () => {
    it('formats error events with warning icon and message text', () => {
        const result = getEventPresentation({
            type: 'error',
            message: 'Cursor Agent failed: authentication required'
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toBe('Cursor Agent failed: authentication required')
    })
})

describe('getEventPresentation — limit-warning', () => {
    it('formats five_hour warning', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour',
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toMatch(/Usage limit 90% \(5-hour\)/)
        expect(result.text).toMatch(/resets/)
    })

    it('formats seven_day warning', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.85,
            endsAt: 1774850400,
            limitType: 'seven_day',
        })

        expect(result.text).toMatch(/Usage limit 85% \(7-day\)/)
    })

    it('omits type label when limitType is empty', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 1,
            endsAt: 1774278000,
            limitType: '',
        })

        expect(result.text).toMatch(/^Usage limit 100% · resets/)
        expect(result.text).not.toMatch(/\(/)
    })

    it('formats unknown limitType with underscore replacement', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.5,
            endsAt: 1774278000,
            limitType: 'thirty_day',
        })

        expect(result.text).toMatch(/\(thirty day\)/)
    })
})

describe('getEventPresentation — limit-reached', () => {
    it('shows limitType when present', () => {
        const result = getEventPresentation({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: 'five_hour',
        })

        expect(result.icon).toBe('⏳')
        expect(result.text).toMatch(/^Usage limit reached \(5-hour\) until/)
    })

    it('omits limitType when empty', () => {
        const result = getEventPresentation({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: '',
        })

        expect(result.icon).toBe('⏳')
        expect(result.text).toMatch(/^Usage limit reached until/)
        expect(result.text).not.toMatch(/\(/)
    })
})

describe('getEventPresentation — token-count', () => {
    it('formats Codex token-count as compact context usage', () => {
        const result = getEventPresentation({
            type: 'token-count',
            info: {
                total: {
                    totalTokens: 23745,
                    inputTokens: 23631,
                    cachedInputTokens: 18176,
                    outputTokens: 114,
                    reasoningOutputTokens: 0
                },
                modelContextWindow: 258400
            }
        })

        expect(result.icon).toBe('◷')
        expect(result.text).toBe('Context 23.6k / 258.4k (9%) · out 114 · cached 18.2k')
    })
})

describe('getEventPresentation — thread goals', () => {
    it('formats goal status updates', () => {
        const result = getEventPresentation({
            type: 'thread-goal-updated',
            goal: {
                threadId: 'thread-1',
                objective: 'ship goal support',
                status: 'budgetLimited',
                tokenBudget: 5000,
                tokensUsed: 4100,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2
            }
        })

        expect(result.text).toBe('Goal limited by budget · 4k / 5k')
    })

    it('formats goal clear events', () => {
        const result = getEventPresentation({ type: 'thread-goal-cleared', threadId: 'thread-1' })

        expect(result.text).toBe('Goal cleared')
    })
})

describe('getEventPresentation — recap (away_summary)', () => {
    it('formats the recap with a recap: prefix', () => {
        const result = getEventPresentation({
            type: 'recap',
            text: 'Building the login flow, next: wire up the submit handler.'
        })

        expect(result.icon).toBe('💭')
        expect(result.text).toBe('recap: Building the login flow, next: wire up the submit handler.')
    })
})

describe('formatResetTime', () => {
    it('formats a unix timestamp to a non-empty string', () => {
        const result = formatResetTime(1774278000)
        expect(result).toBeTruthy()
        expect(typeof result).toBe('string')
    })

    it('handles millisecond timestamps', () => {
        const result = formatResetTime(1774278000000)
        expect(result).toBeTruthy()
    })

    it('returns raw value for invalid timestamps', () => {
        const result = formatResetTime(NaN)
        expect(result).toBeTruthy()
    })
})

describe('formatMessageTimestamp', () => {
    it('formats today without requiring a date prefix', () => {
        const now = new Date(2026, 4, 22, 14, 30)
        const date = new Date(2026, 4, 22, 9, 5)
        const result = formatMessageTimestamp(date, now)
        expect(result).toBe(date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }))
        expect(result).not.toContain('2026')
    })

    it('includes a year for messages outside the current year', () => {
        const now = new Date(2026, 4, 22, 14, 30)
        const result = formatMessageTimestamp(new Date(2025, 11, 31, 23, 59), now)
        expect(result).toContain('2025')
    })
})
