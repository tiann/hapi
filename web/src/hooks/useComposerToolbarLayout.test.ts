import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_COMPOSER_TOOLBAR_LAYOUT,
    moveComposerToolbarItem,
    moveComposerToolbarItemInSingleLayout,
    normalizeComposerToolbarLayout,
} from './useComposerToolbarLayout'

describe('DEFAULT_COMPOSER_TOOLBAR_LAYOUT', () => {
    it('keeps abort last in the default order', () => {
        expect(DEFAULT_COMPOSER_TOOLBAR_LAYOUT.left).toEqual([
            'attachment',
            'settings',
            'expand',
            'piModel',
            'piThinking',
            'terminal',
            'switch',
            'voiceMic',
            'scratchlist',
            'schedule',
            'abort',
        ])
        expect(DEFAULT_COMPOSER_TOOLBAR_LAYOUT.hidden).toEqual([])
    })
})

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
        expect([...result.left, ...result.right, ...result.hidden]).toHaveLength(DEFAULT_COMPOSER_TOOLBAR_LAYOUT.left.length)
    })

    it('preserves hidden tools and keeps newly introduced tools visible', () => {
        const result = normalizeComposerToolbarLayout({
            mode: 'left',
            left: ['attachment'],
            right: [],
            hidden: ['settings', 'abort', 'settings'],
        })

        expect(result.hidden).toEqual(['settings', 'abort'])
        expect(result.left).toContain('schedule')
        expect(result.left).not.toContain('settings')
    })

    it('moves tools between visible and hidden groups without duplication', () => {
        const hidden = moveComposerToolbarItem(DEFAULT_COMPOSER_TOOLBAR_LAYOUT, 'terminal', 'hidden', 0)
        expect(hidden.hidden).toEqual(['terminal'])
        expect(hidden.left).not.toContain('terminal')

        const visible = moveComposerToolbarItem(hidden, 'terminal', 'right', 0)
        expect(visible.hidden).toEqual([])
        expect(visible.right).toEqual(['terminal'])
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
            'expand',
            'abort',
            'switch',
            'attachment',
        ])
        expect(result.left).toHaveLength(layout.left.length)
    })
})
