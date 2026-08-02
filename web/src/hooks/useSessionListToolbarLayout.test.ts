import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT,
    moveSessionListToolbarItem,
    normalizeSessionListToolbarLayout,
} from './useSessionListToolbarLayout'

describe('session list toolbar layout', () => {
    beforeEach(() => localStorage.clear())

    it('preserves the current toolbar by default and keeps removed actions available but hidden', () => {
        expect(DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT).toEqual({
            left: ['search', 'dateFilter'],
            right: ['machineFilter', 'browse'],
            hidden: ['codexImport', 'refresh'],
            searchPresentation: 'icon',
        })
    })

    it('normalizes duplicates, unknown tools, presentation, and missing tools', () => {
        const result = normalizeSessionListToolbarLayout({
            left: ['browse', 'search', 'browse', 'unknown'],
            right: ['dateFilter'],
            hidden: ['refresh', 'search'],
            searchPresentation: 'field',
        })

        expect(result.left).toEqual(['browse', 'search'])
        expect(result.right).toEqual(['dateFilter', 'machineFilter'])
        expect(result.hidden).toEqual(['refresh', 'codexImport'])
        expect(result.searchPresentation).toBe('field')
    })

    it('restores missing tools to their default groups', () => {
        expect(normalizeSessionListToolbarLayout({
            left: [],
            right: [],
            hidden: [],
            searchPresentation: 'icon',
        })).toEqual(DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT)
    })

    it('moves tools between visible and hidden groups without duplication', () => {
        const hidden = moveSessionListToolbarItem(
            DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT,
            'dateFilter',
            'hidden',
            0,
        )
        expect(hidden.hidden[0]).toBe('dateFilter')
        expect(hidden.left).not.toContain('dateFilter')

        const restored = moveSessionListToolbarItem(hidden, 'dateFilter', 'right', 1)
        expect(restored.right).toEqual(['machineFilter', 'dateFilter', 'browse'])
        expect(restored.hidden).not.toContain('dateFilter')
    })
})
