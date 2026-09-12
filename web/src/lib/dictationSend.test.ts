import { describe, expect, it } from 'vitest'
import { dictationDirectSendEligible, isOnSessionPage } from './dictationSend'

describe('dictationDirectSendEligible', () => {
    const base = {
        active: true,
        resolveSessionIdAvailable: false,
        blocksScheduling: false,
        pendingSchedule: null,
        scratchlistMode: false,
    }

    it('allows an active session with no scheduling blockers', () => {
        expect(dictationDirectSendEligible(base)).toBe(true)
    })

    it('allows an inactive session when a session resolver is available', () => {
        expect(dictationDirectSendEligible({
            ...base,
            active: false,
            resolveSessionIdAvailable: true,
        })).toBe(true)
    })

    it('blocks an inactive session without a resolver', () => {
        expect(dictationDirectSendEligible({
            ...base,
            active: false,
        })).toBe(false)
    })

    it('blocks hidden persisted attachment drafts (inactive composer state)', () => {
        // Inactive composers keep persisted attachment blobs out of the visible
        // attachments array; blocksScheduling covers them.
        expect(dictationDirectSendEligible({
            ...base,
            active: false,
            resolveSessionIdAvailable: true,
            blocksScheduling: true,
        })).toBe(false)
    })

    it('blocks visible attachments, pending schedules, and scratchlist mode', () => {
        expect(dictationDirectSendEligible({ ...base, blocksScheduling: true })).toBe(false)
        expect(dictationDirectSendEligible({ ...base, pendingSchedule: { at: 1 } })).toBe(false)
        expect(dictationDirectSendEligible({ ...base, scratchlistMode: true })).toBe(false)
    })
})

describe('isOnSessionPage', () => {
    it('matches the session detail path (with or without trailing slash)', () => {
        expect(isOnSessionPage('/sessions/abc', 'abc')).toBe(true)
        expect(isOnSessionPage('/sessions/abc/', 'abc')).toBe(true)
    })

    it('rejects other sessions and non-session pages', () => {
        expect(isOnSessionPage('/sessions/other', 'abc')).toBe(false)
        expect(isOnSessionPage('/settings', 'abc')).toBe(false)
        expect(isOnSessionPage('/', 'abc')).toBe(false)
    })
})
