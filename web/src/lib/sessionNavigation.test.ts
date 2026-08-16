import { describe, expect, it } from 'vitest'
import {
    getSessionListSelectionNavigation,
    PRESERVE_SESSION_SIDEBAR_SCROLL,
} from './sessionNavigation'

describe('PRESERVE_SESSION_SIDEBAR_SCROLL', () => {
    it('skips router-wide scroll restoration for internal session navigation', () => {
        expect(PRESERVE_SESSION_SIDEBAR_SCROLL).toEqual({ resetScroll: false })
    })
})

describe('getSessionListSelectionNavigation', () => {
    it('preserves the shared sidebar scroll position when selecting a session', () => {
        expect(getSessionListSelectionNavigation('session-active')).toEqual({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-active' },
            resetScroll: false,
        })
    })
})
