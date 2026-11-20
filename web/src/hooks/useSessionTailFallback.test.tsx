import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import type { SyncEvent } from '@/types/api'
import {
    SESSION_TAIL_BUSY_TICK_MS,
    SESSION_TAIL_IDLE_MIN_GAP_MS,
    useSessionTailFallback
} from './useSessionTailFallback'
import {
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    rewindMessageWindow,
    syncTailMessages
} from '@/lib/message-window-store'
import type { MessageWindowState } from '@/lib/message-window-store'

vi.mock('@/lib/message-window-store', () => ({
    clearMessageWindow: vi.fn(),
    getMessageWindowState: vi.fn(),
    ingestIncomingMessages: vi.fn(),
    rewindMessageWindow: vi.fn(),
    syncTailMessages: vi.fn((): Promise<void> => Promise.resolve())
}))

const api = {} as Parameters<typeof useSessionTailFallback>[0]['api']

function windowState(overrides: Partial<MessageWindowState> = {}): MessageWindowState {
    return {
        sessionId: 'sess-1',
        messages: [],
        hasMore: false,
        oldestSeq: null,
        newestSeq: null,
        epoch: 1,
        isSyncingTail: false,
        isLoadingMore: false,
        warning: null,
        viewMode: 'tail',
        requiresLatestReset: false,
        pendingGapRecovery: false,
        hasMoreNewer: false,
        messagesVersion: 0,
        historyVersion: 0,
        tailRevision: 0,
        ...overrides
    }
}

function messageReceived(sessionId: string, messageId: string): SyncEvent {
    return {
        type: 'message-received',
        sessionId,
        message: {
            id: messageId,
            seq: 5,
            createdAt: 123,
            content: { role: 'agent', content: { type: 'text', text: 'hi' } }
        }
    } as unknown as SyncEvent
}

describe('useSessionTailFallback', () => {
    const queryClient = { getQueryData: vi.fn() } as unknown as QueryClient

    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(getMessageWindowState).mockReturnValue(windowState())
        vi.mocked(queryClient.getQueryData).mockReturnValue(undefined)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    function render(sessionId: string | null) {
        return renderHook(
            ({ id }) => useSessionTailFallback({ api, sessionId: id, queryClient }),
            { initialProps: { id: sessionId } }
        )
    }

    it('ingests message-received for the selected session once its window exists', () => {
        const { result } = render('sess-1')
        act(() => {
            result.current(messageReceived('sess-1', 'm-1'))
        })

        expect(ingestIncomingMessages).toHaveBeenCalledWith('sess-1', [
            expect.objectContaining({ id: 'm-1' })
        ])
    })

    it('does not seed a window that was never opened', () => {
        vi.mocked(getMessageWindowState).mockReturnValue(windowState({ epoch: null }))
        const { result } = render('sess-1')
        act(() => {
            result.current(messageReceived('sess-1', 'm-1'))
        })

        expect(ingestIncomingMessages).not.toHaveBeenCalled()
    })

    it('ignores events for other sessions', () => {
        const { result } = render('sess-1')
        act(() => {
            result.current(messageReceived('sess-other', 'm-1'))
        })

        expect(ingestIncomingMessages).not.toHaveBeenCalled()
    })

    it('applies rewind invalidations and resyncs the tail', () => {
        const { result } = render('sess-1')
        act(() => {
            result.current({
                type: 'messages-invalidated',
                sessionId: 'sess-1',
                reason: 'rewind',
                truncateFromLocalId: 'local-9'
            } as unknown as SyncEvent)
        })

        expect(rewindMessageWindow).toHaveBeenCalledWith('sess-1', 'local-9')
        expect(syncTailMessages).toHaveBeenCalledWith(api, 'sess-1')
    })

    it('clears the window on non-rewind invalidations', () => {
        const { result } = render('sess-1')
        act(() => {
            result.current({ type: 'messages-invalidated', sessionId: 'sess-1' } as unknown as SyncEvent)
        })

        expect(clearMessageWindow).toHaveBeenCalledWith('sess-1')
        expect(syncTailMessages).toHaveBeenCalledWith(api, 'sess-1')
    })

    describe('fallback ticker', () => {
        beforeEach(() => {
            vi.useFakeTimers()
        })

        function sessionRow(active: boolean, thinking: boolean) {
            return { sessions: [{ id: 'sess-1', active, thinking }] }
        }

        it('syncs every tick while the session is busy', () => {
            vi.mocked(queryClient.getQueryData).mockReturnValue(sessionRow(true, false))
            render('sess-1')

            act(() => { vi.advanceTimersByTime(SESSION_TAIL_BUSY_TICK_MS) })
            act(() => { vi.advanceTimersByTime(SESSION_TAIL_BUSY_TICK_MS) })

            expect(syncTailMessages).toHaveBeenCalledTimes(2)
            expect(syncTailMessages).toHaveBeenCalledWith(api, 'sess-1', { ensureAfterCurrent: true })
        })

        it('throttles idle sessions to the idle gap', () => {
            vi.mocked(queryClient.getQueryData).mockReturnValue(sessionRow(false, false))
            render('sess-1')

            // First visible tick fires (no sync has happened yet).
            act(() => { vi.advanceTimersByTime(SESSION_TAIL_BUSY_TICK_MS) })
            expect(syncTailMessages).toHaveBeenCalledTimes(1)

            // Further ticks inside the idle gap are held.
            act(() => { vi.advanceTimersByTime(SESSION_TAIL_BUSY_TICK_MS) })
            act(() => { vi.advanceTimersByTime(SESSION_TAIL_BUSY_TICK_MS) })
            expect(syncTailMessages).toHaveBeenCalledTimes(1)

            // Past the 30s idle gap the next tick syncs again.
            act(() => { vi.advanceTimersByTime(SESSION_TAIL_IDLE_MIN_GAP_MS) })
            expect(syncTailMessages).toHaveBeenCalledTimes(2)
        })

        it('skips ticks while the tab is hidden', () => {
            vi.mocked(queryClient.getQueryData).mockReturnValue(sessionRow(true, true))
            const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get')
            visibilitySpy.mockReturnValue('hidden')
            try {
                render('sess-1')
                act(() => { vi.advanceTimersByTime(SESSION_TAIL_BUSY_TICK_MS * 3) })
                expect(syncTailMessages).not.toHaveBeenCalled()
            } finally {
                visibilitySpy.mockRestore()
            }
        })
    })
})
