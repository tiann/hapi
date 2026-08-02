/**
 * Truncate by user-perceived grapheme clusters when the platform provides the
 * Unicode segmenter. The fallback is code-point-safe rather than a complete
 * UAX grapheme implementation, so it never creates a lone surrogate.
 */
export function truncateGraphemes(value: string, maxLength: number): string {
    if (maxLength <= 0 || !value) return ''

    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        let result = ''
        let count = 0
        for (const entry of segmenter.segment(value)) {
            if (count >= maxLength) break
            result += entry.segment
            count += 1
        }
        return result
    }

    return Array.from(value).slice(0, maxLength).join('')
}
