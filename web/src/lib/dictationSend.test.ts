import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import { dictationDirectSendEligible, isOnSessionPage, resolveVoiceSession } from './dictationSend'

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


describe('resolveVoiceSession', () => {
    it.each([false, true])('uses delivery-time activity after a pending transcription: active=%s', async active => {
        let session = { id: 'source', active: !active, permissionMode: 'acceptEdits' } as Session
        const api = {
            getSession: vi.fn(async () => ({ session })),
            resumeSession: vi.fn(async () => 'resumed'),
        }
        const finalize = () => resolveVoiceSession(api, 'source')
        session = { ...session, active, permissionMode: 'default' }
        await expect(finalize()).resolves.toEqual(active
            ? { sessionId: 'source', resumed: false }
            : { sessionId: 'resumed', resumed: true })
        expect(api.getSession).toHaveBeenCalledWith('source')
        if (active) {
            expect(api.resumeSession).not.toHaveBeenCalled()
        } else {
            expect(api.resumeSession).toHaveBeenCalledWith('source', { permissionMode: 'default' })
        }
    })

    it('propagates current-session lookup failures without attempting a resume', async () => {
        const error = new Error('session unavailable')
        const api = { getSession: vi.fn(async () => { throw error }), resumeSession: vi.fn() }
        await expect(resolveVoiceSession(api, 'source')).rejects.toBe(error)
        expect(api.resumeSession).not.toHaveBeenCalled()
    })

    it('propagates resume failure so the pending transcript can be recovered', async () => {
        const error = new Error('resume unavailable')
        const api = {
            getSession: vi.fn(async () => ({ session: { id: 'source', active: false } as Session })),
            resumeSession: vi.fn(async () => { throw error }),
        }
        await expect(resolveVoiceSession(api, 'source')).rejects.toBe(error)
    })
})
