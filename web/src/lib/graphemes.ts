/**
 * Truncate by user-perceived grapheme clusters when the platform provides the
 * Unicode segmenter. The fallback is code-point-safe rather than a complete
 * UAX grapheme implementation, so it never creates a lone surrogate. Both
 * paths retain the original 120 UTF-16-unit title limit.
 */
export function truncateGraphemes(value: string, maxLength: number): string {
    if (maxLength <= 0 || !value) return ''

    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        let result = ''
        for (const entry of segmenter.segment(value)) {
            if (result.length + entry.segment.length > maxLength) break
            result += entry.segment
        }
        return result
    }

    let result = ''
    for (const codePoint of Array.from(value)) {
        if (result.length + codePoint.length > maxLength) break
        result += codePoint
    }
    return result
}
