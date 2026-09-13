import { describe, expect, it } from 'vitest'
import {
    DEFAULT_SESSION_LIST_FILTER_STATE,
    isSessionListFilterSelected,
    toggleSessionListFilter
} from './sessionListFilter'

describe('session list filter state', () => {
    it('toggles each condition independently so filters can be composed', () => {
        const unread = toggleSessionListFilter(DEFAULT_SESSION_LIST_FILTER_STATE, 'unread')
        const combined = toggleSessionListFilter(unread, 'scratchlist')

        expect(combined).toEqual({ unread: true, scratchlist: true })
        expect(isSessionListFilterSelected(combined, 'unread')).toBe(true)
        expect(isSessionListFilterSelected(combined, 'scratchlist')).toBe(true)
        expect(toggleSessionListFilter(combined, 'unread')).toEqual({
            unread: false,
            scratchlist: true
        })
    })
})
