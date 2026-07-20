import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_COMPOSER_TOOLBAR_LAYOUT,
    moveComposerToolbarItemInSingleLayout,
    normalizeComposerToolbarLayout,
} from './useComposerToolbarLayout'

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

    it('reorders across a hidden split boundary in single-column modes', () => {
        const layout = normalizeComposerToolbarLayout({
            mode: 'right',
            left: ['attachment', 'settings', 'piModel', 'piThinking', 'terminal'],
            right: ['abort', 'switch', 'voiceMic', 'scratchlist', 'schedule'],
        })
        const result = moveComposerToolbarItemInSingleLayout(layout, 'attachment', 7)

        expect([...result.left, ...result.right].slice(0, 8)).toEqual([
            'settings',
            'piModel',
            'piThinking',
            'terminal',
            'abort',
            'switch',
            'voiceMic',
            'attachment',
        ])
        expect(result.left).toHaveLength(layout.left.length)
    })
})
