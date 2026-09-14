import { describe, expect, it } from 'vitest'
import { formatCost } from './usage'

describe('formatCost', () => {
    it('formats standard currency amounts', () => {
        expect(formatCost(2.5, 'USD', 'en-US')).toBe('$2.50')
    })

    it('honors an explicit locale', () => {
        const expected = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD' }).format(2.5)
        expect(formatCost(2.5, 'USD', 'de-DE')).toBe(expected)
    })

    it('keeps sub-cent amounts nonzero', () => {
        const rendered = formatCost(0.004, 'USD', 'en-US')
        expect(rendered).not.toBe('$0.00')
        expect(rendered).toContain('0.00')
    })

    it('keeps sub-unit amounts nonzero for zero-decimal currencies', () => {
        const rendered = formatCost(0.4, 'JPY', 'en-US')
        expect(rendered).not.toBe('¥0')
        expect(rendered).toContain('0.4')
    })

    it('falls back to a plain amount for unknown currencies', () => {
        expect(formatCost(0.5, 'NOPE', 'en-US')).toBe('0.5000 NOPE')
    })
})
