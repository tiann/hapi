import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_COMPOSER_TOOLBAR_LAYOUT, normalizeComposerToolbarLayout } from './useComposerToolbarLayout'

describe('normalizeComposerToolbarLayout', () => {
    beforeEach(() => localStorage.clear())

    it('falls back to the default layout for invalid data', () => {
        expect(normalizeComposerToolbarLayout(null)).toEqual(DEFAULT_COMPOSER_TOOLBAR_LAYOUT)
    })

    it('keeps valid order, removes duplicates, and appends newly introduced items', () => {
        const result = normalizeComposerToolbarLayout({
            mode: 'split',
            left: ['settings', 'attachment', 'settings', 'unknown'],
            right: ['abort', 'schedule', 'attachment'],
        })

        expect(result.mode).toBe('split')
        expect(result.left.slice(0, 2)).toEqual(['settings', 'attachment'])
        expect(result.right).toEqual(['abort', 'schedule'])
        expect([...result.left, ...result.right]).toHaveLength(DEFAULT_COMPOSER_TOOLBAR_LAYOUT.left.length)
    })
})
