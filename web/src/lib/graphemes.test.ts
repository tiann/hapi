import { describe, expect, it } from 'vitest'
import { truncateGraphemes } from './graphemes'

const BOUNDARY_SAMPLES = [
    '😀',
    'e\u0301',
    '👨\u200D👩\u200D👧\u200D👦',
]

const CODE_POINT_FALLBACK_SAMPLES = [
    ...BOUNDARY_SAMPLES,
    '한',
    'क्\u200Dष',
    'a\u200Db',
]

function expectGraphemeHardLimit(): void {
    for (const grapheme of BOUNDARY_SAMPLES) {
        const fittingPrefix = 'a'.repeat(120 - grapheme.length)
        const overflowingPrefix = 'a'.repeat(121 - grapheme.length)
        expect(truncateGraphemes(`${fittingPrefix}${grapheme}x`, 120)).toBe(
            `${fittingPrefix}${grapheme}`
        )
        expect(truncateGraphemes(`${overflowingPrefix}${grapheme}x`, 120)).toBe(
            overflowingPrefix
        )
    }
}

function codePointBounded(value: string, maxLength: number): string {
    let result = ''
    for (const codePoint of Array.from(value)) {
        if (result.length + codePoint.length > maxLength) break
        result += codePoint
    }
    return result
}

describe('truncateGraphemes', () => {
    it('keeps only whole 120-UTF-16-unit graphemes', () => {
        expectGraphemeHardLimit()
        expect(truncateGraphemes(`${'a'.repeat(119)}😀`, 120)).toBe('a'.repeat(119))
        expect(truncateGraphemes(`${'a'.repeat(118)}😀`, 120)).toBe(`${'a'.repeat(118)}😀`)
        expect(truncateGraphemes('👨\u200D👩\u200D👧\u200D👦', 2)).toBe('')
        expect(truncateGraphemes('abc', 0)).toBe('')
    })

    it('uses a bounded code-point fallback when Intl.Segmenter is unavailable', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')
        Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined })
        try {
            for (const grapheme of CODE_POINT_FALLBACK_SAMPLES) {
                const source = `${'a'.repeat(119)}${grapheme}x`
                const result = truncateGraphemes(source, 120)
                expect(result).toBe(codePointBounded(source, 120))
                expect(result.length).toBeLessThanOrEqual(120)
                expect(result).not.toMatch(/[\uD800-\uDBFF]$/)
            }
            expect(truncateGraphemes('abc', 0)).toBe('')
        } finally {
            if (descriptor) {
                Object.defineProperty(Intl, 'Segmenter', descriptor)
            } else {
                const mutableIntl = Intl as { Segmenter?: unknown }
                delete mutableIntl.Segmenter
            }
        }
    })
})
