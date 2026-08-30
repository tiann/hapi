/**
 * Tests for the claude /compact completion event builder
 */

import { describe, it, expect } from 'vitest'
import { buildCompactCompletionEvent } from './compactCompletion'

describe('buildCompactCompletionEvent', () => {
    it('reports failure with its reason', () => {
        expect(buildCompactCompletionEvent('context too large', undefined, undefined))
            .toBe('📦 Compaction failed: context too large')
    })

    it('falls back to a generic failure message when no reason is available', () => {
        expect(buildCompactCompletionEvent('', undefined, undefined))
            .toBe('📦 Compaction failed')
    })

    it('emits a token delta line when both tokens are known', () => {
        expect(buildCompactCompletionEvent(null, 34492, 2082))
            .toBe('📦 Compacted (34492 → 2082 tokens)')
    })

    it('omits the delta when tokens are missing', () => {
        expect(buildCompactCompletionEvent(null, undefined, 2082)).toBe('📦 Compacted')
        expect(buildCompactCompletionEvent(null, 34492, undefined)).toBe('📦 Compacted')
        expect(buildCompactCompletionEvent(null, undefined, undefined)).toBe('📦 Compacted')
    })
})
