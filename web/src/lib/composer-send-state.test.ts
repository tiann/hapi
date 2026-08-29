import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import {
    consumeComposerSendSettlement,
    consumePendingComposerSend,
    getComposerDraftRevision,
    getComposerProgrammaticEditRevision,
    getComposerSendSettlement,
    getPendingComposerSend,
    publishComposerSendSettlement,
    recordComposerProgrammaticEdit,
    recordComposerDraftChange,
    recordPendingComposerSend,
    resetComposerSendStateForTests,
} from './composer-send-state'

vi.mock('@/lib/clearDraftsAfterSend', () => ({
    clearDraftsAfterSend: vi.fn(),
}))

const mockClearDraftsAfterSend = vi.mocked(clearDraftsAfterSend)

const settlement = (sessionId: string, attemptId: string): SendMessageSettlement => ({
    sessionId,
    attemptId,
    text: `text-${sessionId}`,
    status: 'success',
    source: 'send',
})

describe('composer send state', () => {
    beforeEach(() => {
        resetComposerSendStateForTests()
        mockClearDraftsAfterSend.mockClear()
    })

    it('retains accepted sends and settlements while the chat tree is unmounted', () => {
        recordPendingComposerSend({
            sessionId: 'session-A',
            attemptId: 'attempt-A',
            text: 'message A',
            programmaticEditRevision: 0,
            draftRevision: 0,
        })
        publishComposerSendSettlement(settlement('session-A', 'attempt-A'))

        expect(getPendingComposerSend('session-A')).toEqual(expect.objectContaining({
            attemptId: 'attempt-A',
        }))
        expect(getComposerSendSettlement('session-A')).toEqual(expect.objectContaining({
            attemptId: 'attempt-A',
        }))

        consumePendingComposerSend('session-A', 'attempt-A')
        consumeComposerSendSettlement('session-A', 'attempt-A')
        expect(getPendingComposerSend('session-A')).toBeNull()
        expect(getComposerSendSettlement('session-A')).toBeNull()
    })

    it('keeps independent session settlements isolated', () => {
        publishComposerSendSettlement(settlement('session-A', 'attempt-A'))
        publishComposerSendSettlement(settlement('session-B', 'attempt-B'))

        consumeComposerSendSettlement('session-B', 'attempt-B')

        expect(getComposerSendSettlement('session-A')).toEqual(expect.objectContaining({
            attemptId: 'attempt-A',
        }))
        expect(getComposerSendSettlement('session-B')).toBeNull()
    })

    it('selects the currently accepted attempt when same-session sends settle out of order', () => {
        recordPendingComposerSend({
            sessionId: 'session-A',
            attemptId: 'attempt-B',
            text: 'message B',
            programmaticEditRevision: 0,
            draftRevision: 0,
        })
        publishComposerSendSettlement(settlement('session-A', 'attempt-B'))
        publishComposerSendSettlement(settlement('session-A', 'attempt-A'))

        expect(getComposerSendSettlement('session-A')?.attemptId).toBe('attempt-B')

        consumeComposerSendSettlement('session-A', 'attempt-B')
        consumePendingComposerSend('session-A', 'attempt-B')
        expect(getComposerSendSettlement('session-A')?.attemptId).toBe('attempt-A')
        consumeComposerSendSettlement('session-A', 'attempt-A')
    })

    it('increments programmatic edit revisions per session', () => {
        expect(getComposerProgrammaticEditRevision('session-A')).toBe(0)
        recordComposerProgrammaticEdit('session-A')
        recordComposerProgrammaticEdit('session-A')
        recordComposerProgrammaticEdit('session-B')
        expect(getComposerProgrammaticEditRevision('session-A')).toBe(2)
        expect(getComposerProgrammaticEditRevision('session-B')).toBe(1)
    })

    it('tracks all draft changes independently per session', () => {
        expect(getComposerDraftRevision('session-A')).toBe(0)
        recordComposerDraftChange('session-A')
        recordComposerProgrammaticEdit('session-A')
        recordComposerDraftChange('session-B')
        expect(getComposerDraftRevision('session-A')).toBe(2)
        expect(getComposerDraftRevision('session-B')).toBe(1)
    })

    it('consumes failed settlements so they cannot reappear after later sends', () => {
        publishComposerSendSettlement({
            ...settlement('session-A', 'attempt-error'),
            status: 'error',
        })

        consumeComposerSendSettlement('session-A', 'attempt-error')

        expect(getComposerSendSettlement('session-A')).toBeNull()
    })

    it('reconciles a successful send when acceptance and settlement meet', () => {
        recordPendingComposerSend({
            sessionId: 'session-A',
            attemptId: 'attempt-A',
            text: 'message A',
            programmaticEditRevision: 0,
            draftRevision: 0,
        })

        publishComposerSendSettlement(settlement('session-A', 'attempt-A'))

        expect(mockClearDraftsAfterSend).toHaveBeenCalledWith(
            'session-A',
            null,
            'text-session-A',
        )
    })

    it('reconciles when settlement arrives before acceptance', () => {
        publishComposerSendSettlement(settlement('session-A', 'attempt-A'))

        recordPendingComposerSend({
            sessionId: 'session-A',
            attemptId: 'attempt-A',
            text: 'message A',
            programmaticEditRevision: 0,
            draftRevision: 0,
        })

        expect(mockClearDraftsAfterSend).toHaveBeenCalledWith(
            'session-A',
            null,
            'text-session-A',
        )
    })

    it('does not reconcile after a newer draft revision', () => {
        recordPendingComposerSend({
            sessionId: 'session-A',
            attemptId: 'attempt-A',
            text: 'message A',
            programmaticEditRevision: 0,
            draftRevision: 0,
        })
        recordComposerDraftChange('session-A')

        publishComposerSendSettlement(settlement('session-A', 'attempt-A'))

        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })
})
