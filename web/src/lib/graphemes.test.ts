import { describe, expect, it } from 'vitest'
import { truncateGraphemes } from './graphemes'

const ASCII_PREFIX = 'a'.repeat(119)
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

function expectBoundarySafeTruncation(): void {
    for (const grapheme of BOUNDARY_SAMPLES) {
        expect(truncateGraphemes(`${ASCII_PREFIX}${grapheme}x`, 120)).toBe(
            `${ASCII_PREFIX}${grapheme}`
        )
    }
}

describe('truncateGraphemes', () => {
    it('keeps the 120th emoji, combining sequence, and ZWJ sequence intact', () => {
        expectBoundarySafeTruncation()
    })

    it('uses a bounded code-point fallback when Intl.Segmenter is unavailable', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')
        Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined })
        try {
            for (const grapheme of CODE_POINT_FALLBACK_SAMPLES) {
                const source = `${ASCII_PREFIX}${grapheme}x`
                const result = truncateGraphemes(source, 120)
                expect(result).toBe(Array.from(source).slice(0, 120).join(''))
                expect(Array.from(result).length).toBeLessThanOrEqual(120)
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
