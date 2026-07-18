import { describe, expect, it } from 'vitest'
import { getEventPresentation, formatResetTime } from './presentation'

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

describe('getEventPresentation — background notification', () => {
    it('renders the notification summary without JSON fallback', () => {
        expect(getEventPresentation({
            type: 'background-notification',
            message: 'Background command stopped',
            internalKind: 'background_notification'
        })).toEqual({ icon: null, text: 'Background command stopped' })
    })
})

describe('getEventPresentation — compact', () => {
    it('renders compact events with pre/post token savings when available', () => {
        const result = getEventPresentation({
            type: 'compact',
            trigger: 'auto',
            source: 'claude',
            preTokens: 1_003_310,
            postTokens: 20_011,
            tokensSaved: 983_299,
            durationMs: 146_000
        })

        expect(result.icon).toBe('📦')
        expect(result.text).toBe('Conversation compacted (1M → 20K, saved 983K tokens)')
    })

    it('falls back to the existing compact text when token details are unavailable', () => {
        expect(getEventPresentation({
            type: 'compact',
            trigger: 'auto',
            source: 'codex'
        }).text).toBe('Conversation compacted')
    })
})

describe('getEventPresentation — Hermes MoA', () => {
    it('renders MoA aggregation status without JSON fallback', () => {
        expect(getEventPresentation({
            type: 'moa-aggregating',
            aggregator: 'agg-model'
        })).toEqual({
            icon: '🧩',
            text: 'MoA aggregating with agg-model'
        })
    })
})
