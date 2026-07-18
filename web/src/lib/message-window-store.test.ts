import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import {
    appendOptimisticMessage,
    clearMessageWindow,
    fetchLatestMessages,
    fetchNewerMessages,
    fetchOlderMessages,
    flushPendingMessages,
    getMessageWindowState,
    ingestIncomingMessages,
    MAX_IDLE_MESSAGE_WINDOWS,
    MESSAGE_WINDOW_IDLE_TTL_MS,
    revalidateLatestMessagesAfterSseConnect,
    returnToLatestMessages,
    seedMessageWindowFromSession,
    setAtBottom,
    subscribeMessageWindow,
} from './message-window-store'

function createMessage(
    id: string,
    seq: number,
    role: 'user' | 'agent' = 'user',
): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: seq,
        content: {
            role,
            content: {
                type: 'text',
                text: id,
            },
        },
    } as DecryptedMessage
}

function latestResponse(messages: DecryptedMessage[]): MessagesResponse {
    const numeric = messages
        .map((message) => message.seq)
        .filter((seq): seq is number => typeof seq === 'number')
    const startSeq = numeric.length > 0 ? Math.min(...numeric) : null
    const endSeq = numeric.length > 0 ? Math.max(...numeric) : null
    return {
        messages,
        page: {
            limit: 50,
            direction: 'latest' as const,
            beforeSeq: null,
            afterSeq: null,
            nextBeforeSeq: startSeq,
            nextAfterSeq: endSeq,
            hasMore: false,
            hasOlder: false,
            hasNewer: false,
            range: startSeq === null || endSeq === null ? null : { startSeq, endSeq },
            startComplete: true,
            endComplete: true,
            continuation: null,
        },
    }
}

function directionalResponse(
    messages: DecryptedMessage[],
    direction: 'older' | 'newer',
    options: { hasOlder: boolean; hasNewer: boolean },
): MessagesResponse {
    const numeric = messages.map((message) => message.seq).filter((seq): seq is number => typeof seq === 'number')
    const startSeq = numeric.length > 0 ? Math.min(...numeric) : null
    const endSeq = numeric.length > 0 ? Math.max(...numeric) : null
    return {
        messages,
        page: {
            limit: 50,
            direction,
            beforeSeq: direction === 'older' ? (endSeq === null ? null : endSeq + 1) : null,
            afterSeq: direction === 'newer' ? (startSeq === null ? null : startSeq - 1) : null,
            nextBeforeSeq: startSeq,
            nextAfterSeq: endSeq,
            hasMore: options.hasOlder,
            hasOlder: options.hasOlder,
            hasNewer: options.hasNewer,
            range: startSeq === null || endSeq === null ? null : { startSeq, endSeq },
            startComplete: true,
            endComplete: true,
            continuation: null,
        },
    }
}

function createTurns(count: number): DecryptedMessage[] {
    return Array.from({ length: count }, (_, index) => {
        const turnNumber = index + 1
        const seq = index * 2 + 1
        return [
            createMessage(`user-${turnNumber}`, seq),
            createMessage(`answer-${turnNumber}`, seq + 1, 'agent'),
        ]
    }).flat()
}

describe('message-window-store idle retention', () => {
    afterEach(() => {
        vi.runOnlyPendingTimers()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('keeps a recent message window after the last subscriber leaves until the idle TTL expires', () => {
        vi.useFakeTimers()
        const sessionId = `session-retain-${Date.now()}`
        const unsubscribe = subscribeMessageWindow(sessionId, vi.fn())
        appendOptimisticMessage(sessionId, createMessage('message-1', 1))

        unsubscribe()

        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual(['message-1'])

        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS - 1)
        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual(['message-1'])

        vi.advanceTimersByTime(1)
        expect(getMessageWindowState(sessionId).messages).toEqual([])
    })

    it('cancels idle cleanup when the same session is subscribed again', () => {
        vi.useFakeTimers()
        const sessionId = `session-resubscribe-${Date.now()}`
        const firstUnsubscribe = subscribeMessageWindow(sessionId, vi.fn())
        appendOptimisticMessage(sessionId, createMessage('message-2', 2))
        firstUnsubscribe()

        vi.advanceTimersByTime(Math.floor(MESSAGE_WINDOW_IDLE_TTL_MS / 2))
        const secondUnsubscribe = subscribeMessageWindow(sessionId, vi.fn())
        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS)

        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual(['message-2'])

        secondUnsubscribe()
    })


    it('waits for an in-flight preload to succeed before marking the session read', async () => {
        vi.useFakeTimers()
        const sessionId = `session-mark-read-race-${Date.now()}`
        let resolvePreload!: (response: MessagesResponse) => void
        const preloadResponse = new Promise<MessagesResponse>((resolve) => {
            resolvePreload = resolve
        })
        const api = {
            getMessages: vi.fn(() => preloadResponse),
            markSessionRead: vi.fn(async () => {}),
        }

        const preload = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        const markRead = fetchLatestMessages(api as never, sessionId, { markRead: true })
        await Promise.resolve()

        expect(api.markSessionRead).not.toHaveBeenCalled()
        resolvePreload(latestResponse([createMessage('latest', 1)]))

        await expect(preload).resolves.toBe(true)
        await expect(markRead).resolves.toBe(true)
        expect(api.getMessages).toHaveBeenCalledTimes(1)
        expect(api.markSessionRead).toHaveBeenCalledWith(sessionId)
    })

    it('does not mark read or report success when an in-flight preload fails', async () => {
        vi.useFakeTimers()
        const sessionId = `session-mark-read-preload-failure-${Date.now()}`
        let rejectPreload!: (error: Error) => void
        const preloadResponse = new Promise<MessagesResponse>((_resolve, reject) => {
            rejectPreload = reject
        })
        const api = {
            getMessages: vi.fn(() => preloadResponse),
            markSessionRead: vi.fn(async () => {}),
        }

        const preload = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        const markRead = fetchLatestMessages(api as never, sessionId, { markRead: true })
        await Promise.resolve()
        rejectPreload(new Error('preload failed'))

        await expect(preload).resolves.toBe(false)
        await expect(markRead).resolves.toBe(false)
        expect(api.markSessionRead).not.toHaveBeenCalled()
    })

    it('explicitly clears a window and lets the reset idle state expire', () => {
        vi.useFakeTimers()
        const sessionId = `session-clear-${Date.now()}`
        const unsubscribe = subscribeMessageWindow(sessionId, vi.fn())
        appendOptimisticMessage(sessionId, createMessage('message-clear', 1))
        unsubscribe()

        clearMessageWindow(sessionId)

        expect(getMessageWindowState(sessionId).messages).toEqual([])
        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS)
        expect(getMessageWindowState(sessionId).messages).toEqual([])
    })

    it('keeps an explicitly cleared window empty when an older latest request resolves', async () => {
        vi.useFakeTimers()
        const sessionId = `session-clear-in-flight-latest-${Date.now()}`
        let resolveLatest!: (response: MessagesResponse) => void
        const delayedLatest = new Promise<MessagesResponse>((resolve) => {
            resolveLatest = resolve
        })
        const api = {
            getMessages: vi.fn(() => delayedLatest),
            markSessionRead: vi.fn(async () => {}),
        }

        const activeFetch = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        expect(api.getMessages).toHaveBeenCalledTimes(1)
        const queuedReconnect = revalidateLatestMessagesAfterSseConnect(api as never, sessionId)

        clearMessageWindow(sessionId)
        expect(getMessageWindowState(sessionId).messages).toEqual([])

        resolveLatest(latestResponse([createMessage('removed-session-row', 1)]))
        expect(await activeFetch).toBe(false)
        expect(await queuedReconnect).toBe(false)

        expect(api.getMessages).toHaveBeenCalledTimes(1)
        expect(getMessageWindowState(sessionId).messages).toEqual([])
    })

    it('starts a fresh latest request immediately after clear without waiting for invalidated work', async () => {
        vi.useFakeTimers()
        const sessionId = `session-clear-restarts-latest-${Date.now()}`
        let resolveStaleLatest!: (response: MessagesResponse) => void
        const staleLatest = new Promise<MessagesResponse>((resolve) => {
            resolveStaleLatest = resolve
        })
        const api = {
            getMessages: vi.fn()
                .mockImplementationOnce(() => staleLatest)
                .mockResolvedValueOnce(latestResponse([createMessage('fresh-row', 2)])),
            markSessionRead: vi.fn(async () => {}),
        }

        const staleFetch = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        expect(api.getMessages).toHaveBeenCalledTimes(1)
        clearMessageWindow(sessionId)

        const freshFetch = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        const callsBeforeStaleResolution = api.getMessages.mock.calls.length
        resolveStaleLatest(latestResponse([createMessage('stale-row', 1)]))
        const [staleResult, freshResult] = await Promise.all([staleFetch, freshFetch])

        expect(callsBeforeStaleResolution).toBe(2)
        expect(staleResult).toBe(false)
        expect(freshResult).toBe(true)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual(['fresh-row'])
    })

    it('does not resurrect an idle-evicted window when its latest request resolves', async () => {
        vi.useFakeTimers()
        const sessionId = `session-evict-in-flight-latest-${Date.now()}`
        let resolveLatest!: (response: MessagesResponse) => void
        const delayedLatest = new Promise<MessagesResponse>((resolve) => {
            resolveLatest = resolve
        })
        const api = {
            getMessages: vi.fn(() => delayedLatest),
            markSessionRead: vi.fn(async () => {}),
        }

        const activeFetch = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS)

        resolveLatest(latestResponse([createMessage('expired-row', 1)]))
        expect(await activeFetch).toBe(false)
        expect(getMessageWindowState(sessionId).messages).toEqual([])
    })

    it('starts a fresh idle lifetime when seeding replaces a destination lifecycle', () => {
        vi.useFakeTimers()
        const sourceSessionId = `session-seed-source-${Date.now()}`
        const destinationSessionId = `session-seed-destination-${Date.now()}`
        appendOptimisticMessage(sourceSessionId, createMessage('seeded-row', 2))
        const unsubscribe = subscribeMessageWindow(destinationSessionId, vi.fn())
        appendOptimisticMessage(destinationSessionId, createMessage('old-destination-row', 1))
        unsubscribe()

        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS - 1)
        seedMessageWindowFromSession(sourceSessionId, destinationSessionId)
        expect(getMessageWindowState(destinationSessionId).messages.map((message) => message.id)).toEqual([
            'seeded-row',
        ])

        vi.advanceTimersByTime(1)
        expect(getMessageWindowState(destinationSessionId).messages.map((message) => message.id)).toEqual([
            'seeded-row',
        ])

        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS - 1)
        expect(getMessageWindowState(destinationSessionId).messages).toEqual([])
    })

    it('evicts the oldest idle message window when the idle cache exceeds its cap', () => {
        vi.useFakeTimers()
        const sessionIds = Array.from({ length: MAX_IDLE_MESSAGE_WINDOWS + 1 }, (_, index) => (
            `session-evict-${Date.now()}-${index}`
        ))

        for (const [index, sessionId] of sessionIds.entries()) {
            const unsubscribe = subscribeMessageWindow(sessionId, vi.fn())
            appendOptimisticMessage(sessionId, createMessage(`message-${index}`, index))
            unsubscribe()
        }

        expect(getMessageWindowState(sessionIds[0]).messages).toEqual([])
        expect(getMessageWindowState(sessionIds.at(-1)!).messages.map((message) => message.id)).toEqual([
            `message-${MAX_IDLE_MESSAGE_WINDOWS}`,
        ])
    })

    it('pins an unmatched optimistic send when the idle cache exceeds its cap', () => {
        vi.useFakeTimers()
        const sessionIds = Array.from({ length: MAX_IDLE_MESSAGE_WINDOWS + 1 }, (_, index) => (
            `session-optimistic-cap-${Date.now()}-${index}`
        ))
        const optimisticId = 'local-idle-cap-send'

        for (const [index, sessionId] of sessionIds.entries()) {
            const unsubscribe = subscribeMessageWindow(sessionId, vi.fn())
            appendOptimisticMessage(sessionId, index === 0
                ? {
                    ...createMessage(optimisticId, 1),
                    id: optimisticId,
                    seq: null,
                    localId: optimisticId,
                    status: 'sending' as const,
                }
                : createMessage(`ordinary-message-${index}`, index))
            unsubscribe()
        }

        expect(getMessageWindowState(sessionIds[0]).messages.map((message) => message.id)).toEqual([
            optimisticId,
        ])
        expect(getMessageWindowState(sessionIds[1]).messages).toEqual([])
        expect(getMessageWindowState(sessionIds.at(-1)!).messages.map((message) => message.id)).toEqual([
            `ordinary-message-${MAX_IDLE_MESSAGE_WINDOWS}`,
        ])
    })

    it('pins an unmatched optimistic send past idle TTL and expires it after acknowledgement', () => {
        vi.useFakeTimers()
        const sessionId = `session-optimistic-ttl-${Date.now()}`
        const localId = 'local-idle-ttl-send'
        const unsubscribe = subscribeMessageWindow(sessionId, vi.fn())
        appendOptimisticMessage(sessionId, {
            ...createMessage(localId, 1),
            id: localId,
            seq: null,
            localId,
            status: 'sending' as const,
        })
        unsubscribe()

        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS)
        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual([localId])

        ingestIncomingMessages(sessionId, [{
            ...createMessage('stored-idle-ttl-send', 1),
            localId,
        }])
        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual([
            'stored-idle-ttl-send',
        ])

        vi.advanceTimersByTime(MESSAGE_WINDOW_IDLE_TTL_MS)
        expect(getMessageWindowState(sessionId).messages).toEqual([])
    })
})

describe('message-window-store complete latest pages', () => {
    it('keeps a 1,000-pair single turn intact on cold load', async () => {
        const sessionId = `session-cold-huge-turn-${Date.now()}`
        const messages = [
            createMessage('stress-question', 1),
            ...Array.from({ length: 2_000 }, (_, index) => (
                createMessage(`tool-event-${index}`, index + 2, 'agent')
            )),
            createMessage('stress-final-answer', 2_002, 'agent'),
        ]
        const api = {
            getMessages: vi.fn(async () => latestResponse(messages)),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(state.messages).toHaveLength(2_002)
        expect(state.messages[0]?.id).toBe('stress-question')
        expect(state.messages.at(-1)?.id).toBe('stress-final-answer')
        expect(state.ranges).toEqual([{ startSeq: 1, endSeq: 2_002 }])
        expect(state.gaps).toEqual([])
    })

    it('replaces a distant historical window on exact return to latest', async () => {
        const sessionId = `session-exact-latest-${Date.now()}`
        appendOptimisticMessage(sessionId, createMessage('old-question', 1))
        appendOptimisticMessage(sessionId, createMessage('old-answer', 2, 'agent'))
        const latest = [
            createMessage('latest-question', 100),
            createMessage('latest-answer', 101, 'agent'),
        ]
        const api = {
            getMessages: vi.fn(async () => latestResponse(latest)),
            markSessionRead: vi.fn(async () => {}),
        }

        await returnToLatestMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.id)).toEqual([
            'latest-question',
            'latest-answer',
        ])
        expect(state.gaps).toEqual([])
        expect(state.hasNewer).toBe(false)
    })

    it('keeps a review window isolated when exact latest fails', async () => {
        const sessionId = `session-exact-latest-failure-${Date.now()}`
        appendOptimisticMessage(sessionId, createMessage('review-question', 1))
        appendOptimisticMessage(sessionId, createMessage('review-answer', 2, 'agent'))
        setAtBottom(sessionId, false)
        const before = getMessageWindowState(sessionId)
        const visibleReference = before.messages
        const api = {
            getMessages: vi.fn(async () => {
                throw new Error('latest unavailable')
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        const succeeded = await returnToLatestMessages(api as never, sessionId)

        const after = getMessageWindowState(sessionId)
        expect(succeeded).toBe(false)
        expect(after.atBottom).toBe(false)
        expect(after.messages).toBe(visibleReference)
        expect(after.warning).toMatch(/latest unavailable/i)
    })

    it('waits for an active latest fetch and then performs the exact canonical fetch', async () => {
        const sessionId = `session-exact-latest-serialized-${Date.now()}`
        let resolveFirst!: (response: MessagesResponse) => void
        const firstResponse = new Promise<MessagesResponse>((resolve) => {
            resolveFirst = resolve
        })
        const stale = [
            createMessage('stale-question', 1),
            createMessage('stale-answer', 2, 'agent'),
        ]
        const canonical = [
            createMessage('canonical-question', 100),
            createMessage('canonical-answer', 101, 'agent'),
        ]
        const api = {
            getMessages: vi.fn()
                .mockImplementationOnce(() => firstResponse)
                .mockImplementationOnce(async () => latestResponse(canonical)),
            markSessionRead: vi.fn(async () => {}),
        }

        const initialFetch = fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, false)
        const exactFetch = returnToLatestMessages(api as never, sessionId)
        await Promise.resolve()
        expect(api.getMessages).toHaveBeenCalledTimes(1)

        resolveFirst(latestResponse(stale))
        await initialFetch
        const succeeded = await exactFetch

        const state = getMessageWindowState(sessionId)
        expect(succeeded).toBe(true)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        expect(state.messages.map((row) => row.id)).toEqual([
            'canonical-question',
            'canonical-answer',
        ])
        expect(state.pending).toEqual([])
        expect(state.atBottom).toBe(true)
    })

    it('queues one post-subscription revalidation behind an active cold latest snapshot', async () => {
        const sessionId = `session-latest-post-subscription-${Date.now()}`
        let resolveColdSnapshot!: (response: MessagesResponse) => void
        const coldSnapshot = new Promise<MessagesResponse>((resolve) => {
            resolveColdSnapshot = resolve
        })
        const api = {
            getMessages: vi.fn()
                .mockImplementationOnce(() => coldSnapshot)
                .mockImplementationOnce(async () => latestResponse([
                    createMessage('snapshot-100', 100),
                    createMessage('persisted-before-subscription-101', 101, 'agent'),
                ])),
            markSessionRead: vi.fn(async () => {}),
        }

        const coldFetch = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        const firstConnectRevalidation = revalidateLatestMessagesAfterSseConnect(api as never, sessionId)
        const duplicateConnectRevalidation = revalidateLatestMessagesAfterSseConnect(api as never, sessionId)
        expect(api.getMessages).toHaveBeenCalledTimes(1)

        resolveColdSnapshot(latestResponse([createMessage('snapshot-100', 100)]))
        await Promise.all([coldFetch, firstConnectRevalidation, duplicateConnectRevalidation])

        const state = getMessageWindowState(sessionId)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        expect(state.messages.map((message) => message.id)).toEqual([
            'snapshot-100',
            'persisted-before-subscription-101',
        ])
        expect(state.gaps).toEqual([])
        expect(state.hasNewer).toBe(false)
    })

    it('does not start a stale continuation after clear invalidates the initial latest response', async () => {
        const sessionId = `session-clear-before-latest-continuation-${Date.now()}`
        let resolveInitial!: (response: MessagesResponse) => void
        const delayedInitial = new Promise<MessagesResponse>((resolve) => {
            resolveInitial = resolve
        })
        const api = {
            getMessages: vi.fn()
                .mockImplementationOnce(() => delayedInitial)
                .mockResolvedValueOnce(latestResponse([createMessage('forbidden-continuation-row', 1)])),
            markSessionRead: vi.fn(async () => {}),
        }

        const activeFetch = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        const queuedReconnect = revalidateLatestMessagesAfterSseConnect(api as never, sessionId)
        clearMessageWindow(sessionId)

        const incomplete = latestResponse([createMessage('stale-tail', 2)])
        incomplete.page.startComplete = false
        incomplete.page.continuation = { direction: 'older', cursorSeq: 2 }
        resolveInitial(incomplete)

        expect(await activeFetch).toBe(false)
        expect(await queuedReconnect).toBe(false)
        expect(api.getMessages).toHaveBeenCalledTimes(1)
        expect(getMessageWindowState(sessionId).messages).toEqual([])
    })

    it('does not continue an incomplete chain after clear while a continuation is in flight', async () => {
        const sessionId = `session-clear-during-latest-continuation-${Date.now()}`
        let resolveContinuation!: (response: MessagesResponse) => void
        const delayedContinuation = new Promise<MessagesResponse>((resolve) => {
            resolveContinuation = resolve
        })
        const initial = latestResponse([createMessage('tail-row', 3)])
        initial.page.startComplete = false
        initial.page.continuation = { direction: 'older', cursorSeq: 3 }
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(initial)
                .mockImplementationOnce(() => delayedContinuation)
                .mockResolvedValueOnce(latestResponse([createMessage('forbidden-third-page', 1)])),
            markSessionRead: vi.fn(async () => {}),
        }

        const activeFetch = fetchLatestMessages(api as never, sessionId)
        await vi.waitFor(() => expect(api.getMessages).toHaveBeenCalledTimes(2))
        clearMessageWindow(sessionId)

        const incompleteContinuation = directionalResponse([
            createMessage('middle-row', 2),
        ], 'older', { hasOlder: true, hasNewer: true })
        incompleteContinuation.page.startComplete = false
        incompleteContinuation.page.continuation = { direction: 'older', cursorSeq: 2 }
        resolveContinuation(incompleteContinuation)

        expect(await activeFetch).toBe(false)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        expect(getMessageWindowState(sessionId).messages).toEqual([])
    })

    it('retains messages that arrive after the exact latest response snapshot', async () => {
        const sessionId = `session-exact-latest-live-race-${Date.now()}`
        appendOptimisticMessage(sessionId, createMessage('review-question', 1))
        appendOptimisticMessage(sessionId, createMessage('review-answer', 2, 'agent'))
        setAtBottom(sessionId, false)
        let resolveLatest!: (response: MessagesResponse) => void
        const latestPage = new Promise<MessagesResponse>((resolve) => {
            resolveLatest = resolve
        })
        const api = {
            getMessages: vi.fn(() => latestPage),
            markSessionRead: vi.fn(async () => {}),
        }

        const exactFetch = returnToLatestMessages(api as never, sessionId)
        await Promise.resolve()
        ingestIncomingMessages(sessionId, [createMessage('live-after-snapshot', 102, 'agent')])
        resolveLatest(latestResponse([
            createMessage('canonical-question', 100),
            createMessage('canonical-answer', 101, 'agent'),
        ]))
        const succeeded = await exactFetch

        const state = getMessageWindowState(sessionId)
        expect(succeeded).toBe(true)
        expect(state.messages.map((row) => row.id)).toEqual([
            'canonical-question',
            'canonical-answer',
            'live-after-snapshot',
        ])
        expect(state.pending).toEqual([])
        expect(state.atBottom).toBe(true)
    })

    it('retains a post-snapshot live row and exposes its missing predecessor on an ordinary latest fetch', async () => {
        const sessionId = `session-latest-live-gap-race-${Date.now()}`
        let resolveLatest!: (response: MessagesResponse) => void
        const latestPage = new Promise<MessagesResponse>((resolve) => {
            resolveLatest = resolve
        })
        const api = {
            getMessages: vi.fn(() => latestPage),
            markSessionRead: vi.fn(async () => {}),
        }

        const fetch = fetchLatestMessages(api as never, sessionId)
        await Promise.resolve()
        ingestIncomingMessages(sessionId, [createMessage('live-after-stale-snapshot', 102, 'agent')])
        resolveLatest(latestResponse(Array.from({ length: 100 }, (_, index) => (
            createMessage(`snapshot-${index + 1}`, index + 1)
        ))))
        expect(await fetch).toBe(true)

        const state = getMessageWindowState(sessionId)
        expect(state.messages.some((message) => message.id === 'live-after-stale-snapshot')).toBe(true)
        expect(state.ranges.at(-1)).toEqual({ startSeq: 102, endSeq: 102 })
        expect(state.gaps.at(-1)).toEqual({ afterSeq: 100, beforeSeq: 102 })
        expect(state.warning).toMatch(/sequence gap/i)
    })

    it('reconciles an optimistic row with its persisted localId echo during exact latest', async () => {
        const sessionId = `session-exact-latest-local-id-${Date.now()}`
        appendOptimisticMessage(sessionId, {
            ...createMessage('local-user-1', 1),
            localId: 'local-user-1',
            status: 'sending' as const,
        })
        const storedEcho = {
            ...createMessage('stored-user-1', 1),
            localId: 'local-user-1',
        }
        const api = {
            getMessages: vi.fn(async () => latestResponse([storedEcho])),
            markSessionRead: vi.fn(async () => {}),
        }

        expect(await returnToLatestMessages(api as never, sessionId)).toBe(true)

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.id)).toEqual(['stored-user-1'])
        expect(state.pending).toEqual([])
        expect(state.gaps).toEqual([])
    })

    it('retries exact latest when live pending turns overflow during the snapshot request', async () => {
        const sessionId = `session-exact-latest-overflow-race-${Date.now()}`
        appendOptimisticMessage(sessionId, createMessage('review-question', 1))
        appendOptimisticMessage(sessionId, createMessage('review-answer', 2, 'agent'))
        setAtBottom(sessionId, false)

        let resolveFirstLatest!: (response: MessagesResponse) => void
        const firstLatest = new Promise<MessagesResponse>((resolve) => {
            resolveFirstLatest = resolve
        })
        const canonical = [
            createMessage('canonical-question', 100),
            createMessage('canonical-answer', 101, 'agent'),
        ]
        const liveTurns = createTurns(9).map((message) => ({
            ...message,
            id: `live-${message.id}`,
            seq: (message.seq ?? 0) + 101,
            createdAt: message.createdAt + 101,
        }))
        const api = {
            getMessages: vi.fn()
                .mockImplementationOnce(() => firstLatest)
                .mockImplementationOnce(async () => latestResponse([...canonical, ...liveTurns])),
            markSessionRead: vi.fn(async () => {}),
        }

        const exactFetch = returnToLatestMessages(api as never, sessionId)
        await Promise.resolve()
        ingestIncomingMessages(sessionId, liveTurns)
        expect(getMessageWindowState(sessionId).warning).toMatch(/refresh/i)

        resolveFirstLatest(latestResponse(canonical))
        expect(await exactFetch).toBe(true)

        const state = getMessageWindowState(sessionId)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        expect(state.messages.map((message) => message.id)).toEqual(
            [...canonical, ...liveTurns].map((message) => message.id),
        )
        expect(state.pending).toEqual([])
        expect(state.pendingCount).toBe(0)
        expect(state.gaps).toEqual([])
        expect(state.hasNewer).toBe(false)
        expect(state.atBottom).toBe(true)
    })

    it('ignores an older page that completes after an exact return to latest', async () => {
        const sessionId = `session-exact-latest-stale-older-${Date.now()}`
        let latestRequestCount = 0
        let resolveOlder!: (response: MessagesResponse) => void
        const olderPage = new Promise<MessagesResponse>((resolve) => {
            resolveOlder = resolve
        })
        const reviewWindow = [
            createMessage('review-question', 51),
            createMessage('review-answer', 52, 'agent'),
        ]
        const canonical = [
            createMessage('canonical-question', 100),
            createMessage('canonical-answer', 101, 'agent'),
        ]
        const api = {
            getMessages: vi.fn((_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 51) {
                    return olderPage
                }
                latestRequestCount += 1
                if (latestRequestCount === 1) {
                    const response = latestResponse(reviewWindow)
                    response.page.hasMore = true
                    response.page.hasOlder = true
                    response.page.hasNewer = true
                    return Promise.resolve(response)
                }
                return Promise.resolve(latestResponse(canonical))
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const staleFetch = fetchOlderMessages(api as never, sessionId)
        await vi.waitFor(() => {
            expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({
                beforeSeq: 51,
            }))
        })

        expect(await returnToLatestMessages(api as never, sessionId)).toBe(true)
        resolveOlder(directionalResponse([
            createMessage('stale-question', 1),
            createMessage('stale-answer', 2, 'agent'),
        ], 'older', { hasOlder: false, hasNewer: true }))
        await staleFetch

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((row) => row.id)).toEqual([
            'canonical-question',
            'canonical-answer',
        ])
        expect(state.ranges).toEqual([{ startSeq: 100, endSeq: 101 }])
        expect(state.gaps).toEqual([])
        expect(state.hasNewer).toBe(false)
        expect(state.isLoadingOlder).toBe(false)
        expect(state.atBottom).toBe(true)
    })

    it('invalidates an older page that resolves while exact latest is still in flight', async () => {
        const sessionId = `session-exact-latest-overlapping-older-${Date.now()}`
        let latestRequestCount = 0
        let resolveOlder!: (response: MessagesResponse) => void
        let resolveLatest!: (response: MessagesResponse) => void
        const olderPage = new Promise<MessagesResponse>((resolve) => {
            resolveOlder = resolve
        })
        const exactLatestPage = new Promise<MessagesResponse>((resolve) => {
            resolveLatest = resolve
        })
        const reviewWindow = [
            createMessage('review-question', 51),
            createMessage('review-answer', 52, 'agent'),
        ]
        const canonical = [
            createMessage('canonical-question', 100),
            createMessage('canonical-answer', 101, 'agent'),
        ]
        const api = {
            getMessages: vi.fn((_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 51) {
                    return olderPage
                }
                latestRequestCount += 1
                if (latestRequestCount === 1) {
                    const response = latestResponse(reviewWindow)
                    response.page.hasMore = true
                    response.page.hasOlder = true
                    response.page.hasNewer = true
                    return Promise.resolve(response)
                }
                return exactLatestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const overlappingOlderFetch = fetchOlderMessages(api as never, sessionId)
        await vi.waitFor(() => {
            expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({
                beforeSeq: 51,
            }))
        })

        const exactFetch = returnToLatestMessages(api as never, sessionId)
        await vi.waitFor(() => expect(latestRequestCount).toBe(2))
        resolveOlder(directionalResponse([
            createMessage('stale-question', 1),
            createMessage('stale-answer', 2, 'agent'),
        ], 'older', { hasOlder: false, hasNewer: true }))
        await overlappingOlderFetch
        resolveLatest(latestResponse(canonical))

        expect(await exactFetch).toBe(true)
        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((row) => row.id)).toEqual([
            'canonical-question',
            'canonical-answer',
        ])
        expect(state.ranges).toEqual([{ startSeq: 100, endSeq: 101 }])
        expect(state.gaps).toEqual([])
        expect(state.hasNewer).toBe(false)
        expect(state.atBottom).toBe(true)
    })

    it('clears invalidated directional locks without letting a stale completion clear a newer request', async () => {
        const sessionId = `session-exact-latest-direction-lock-${Date.now()}`
        let latestRequestCount = 0
        let resolveStaleOlder!: (response: MessagesResponse) => void
        let resolveFreshOlder!: (response: MessagesResponse) => void
        const staleOlderPage = new Promise<MessagesResponse>((resolve) => {
            resolveStaleOlder = resolve
        })
        const freshOlderPage = new Promise<MessagesResponse>((resolve) => {
            resolveFreshOlder = resolve
        })
        const reviewWindow = Array.from({ length: 40 }, (_, index) => (
            createMessage(`review-${index + 51}`, index + 51)
        ))
        const canonical = Array.from({ length: 40 }, (_, index) => (
            createMessage(`canonical-${index + 61}`, index + 61)
        ))
        const api = {
            getMessages: vi.fn((_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 51) return staleOlderPage
                if (options.beforeSeq === 61) return freshOlderPage
                latestRequestCount += 1
                const response = latestResponse(latestRequestCount === 1 ? reviewWindow : canonical)
                response.page.hasMore = true
                response.page.hasOlder = true
                return Promise.resolve(response)
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const staleFetch = fetchOlderMessages(api as never, sessionId)
        await vi.waitFor(() => {
            expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({ beforeSeq: 51 }))
        })

        expect(await returnToLatestMessages(api as never, sessionId)).toBe(true)
        expect(getMessageWindowState(sessionId).isLoadingOlder).toBe(false)

        const freshFetch = fetchOlderMessages(api as never, sessionId)
        await vi.waitFor(() => {
            expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({ beforeSeq: 61 }))
        })
        resolveStaleOlder(directionalResponse(
            Array.from({ length: 20 }, (_, index) => createMessage(`stale-${index + 31}`, index + 31)),
            'older',
            { hasOlder: true, hasNewer: true },
        ))
        await staleFetch

        expect(getMessageWindowState(sessionId).isLoadingOlder).toBe(true)

        resolveFreshOlder(directionalResponse(
            Array.from({ length: 20 }, (_, index) => createMessage(`fresh-${index + 41}`, index + 41)),
            'older',
            { hasOlder: true, hasNewer: true },
        ))
        await freshFetch

        const state = getMessageWindowState(sessionId)
        expect(state.isLoadingOlder).toBe(false)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 40 }, (_, index) => index + 41),
        )
        expect(state.gaps).toEqual([])
    })

    it('does not start directional requests while exact latest is in flight', async () => {
        const sessionId = `session-exact-latest-blocks-directional-${Date.now()}`
        let latestRequestCount = 0
        let resolveLatest!: (response: MessagesResponse) => void
        const exactLatestPage = new Promise<MessagesResponse>((resolve) => {
            resolveLatest = resolve
        })
        const reviewWindow = [
            createMessage('review-question', 51),
            createMessage('review-answer', 52, 'agent'),
        ]
        const canonical = [
            createMessage('canonical-question', 100),
            createMessage('canonical-answer', 101, 'agent'),
        ]
        const api = {
            getMessages: vi.fn((_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq !== null && options.beforeSeq !== undefined) {
                    return Promise.resolve(directionalResponse([
                        createMessage('stale-older', 50),
                    ], 'older', { hasOlder: true, hasNewer: true }))
                }
                if (options.afterSeq !== null && options.afterSeq !== undefined) {
                    return Promise.resolve(directionalResponse([
                        createMessage('stale-newer', 53),
                    ], 'newer', { hasOlder: true, hasNewer: true }))
                }
                latestRequestCount += 1
                if (latestRequestCount === 1) {
                    const response = latestResponse(reviewWindow)
                    response.page.hasMore = true
                    response.page.hasOlder = true
                    response.page.hasNewer = true
                    return Promise.resolve(response)
                }
                return exactLatestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const exactFetch = returnToLatestMessages(api as never, sessionId)
        await vi.waitFor(() => expect(latestRequestCount).toBe(2))

        await fetchOlderMessages(api as never, sessionId)
        await fetchNewerMessages(api as never, sessionId)

        const directionalCalls = api.getMessages.mock.calls.filter(([, options]) => (
            (options.beforeSeq !== null && options.beforeSeq !== undefined)
            || (options.afterSeq !== null && options.afterSeq !== undefined)
        ))
        expect(directionalCalls).toEqual([])

        resolveLatest(latestResponse(canonical))
        expect(await exactFetch).toBe(true)
        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual([
            'canonical-question',
            'canonical-answer',
        ])
    })

    it('ignores a newer page that completes after an exact return to latest', async () => {
        const sessionId = `session-exact-latest-stale-newer-${Date.now()}`
        let latestRequestCount = 0
        let resolveNewer!: (response: MessagesResponse) => void
        const newerPage = new Promise<MessagesResponse>((resolve) => {
            resolveNewer = resolve
        })
        const reviewWindow = [
            createMessage('review-question', 51),
            createMessage('review-answer', 52, 'agent'),
        ]
        const canonical = [
            createMessage('canonical-question', 100),
            createMessage('canonical-answer', 101, 'agent'),
        ]
        const api = {
            getMessages: vi.fn((_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.afterSeq === 52) {
                    return newerPage
                }
                latestRequestCount += 1
                if (latestRequestCount === 1) {
                    const response = latestResponse(reviewWindow)
                    response.page.hasNewer = true
                    return Promise.resolve(response)
                }
                return Promise.resolve(latestResponse(canonical))
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const staleFetch = fetchNewerMessages(api as never, sessionId)
        await vi.waitFor(() => {
            expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({
                afterSeq: 52,
            }))
        })

        expect(await returnToLatestMessages(api as never, sessionId)).toBe(true)
        resolveNewer(directionalResponse([
            createMessage('stale-question', 53),
            createMessage('stale-answer', 54, 'agent'),
        ], 'newer', { hasOlder: true, hasNewer: true }))
        await staleFetch

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((row) => row.id)).toEqual([
            'canonical-question',
            'canonical-answer',
        ])
        expect(state.ranges).toEqual([{ startSeq: 100, endSeq: 101 }])
        expect(state.gaps).toEqual([])
        expect(state.hasNewer).toBe(false)
        expect(state.isLoadingNewer).toBe(false)
        expect(state.atBottom).toBe(true)
    })

    it('stitches explicit older continuation pages before exposing latest messages', async () => {
        const sessionId = `session-latest-continuation-${Date.now()}`
        const tail = [
            createMessage('event-3', 3, 'agent'),
            createMessage('answer-4', 4, 'agent'),
        ]
        const prefix = [
            createMessage('question-1', 1),
            createMessage('event-2', 2, 'agent'),
        ]
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: { beforeSeq?: number | null }) => {
                if (options.beforeSeq === 3) {
                    const response = directionalResponse(prefix, 'older', {
                        hasOlder: false,
                        hasNewer: true,
                    })
                    response.page.endComplete = false
                    return response
                }
                const response = latestResponse(tail)
                response.page.startComplete = false
                response.page.continuation = { direction: 'older', cursorSeq: 3 }
                return response
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        expect(state.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4])
        expect(state.ranges).toEqual([{ startSeq: 1, endSeq: 4 }])
        expect(state.gaps).toEqual([])
    })

    it('surfaces a sequence discontinuity instead of silently treating it as continuous', async () => {
        const sessionId = `session-visible-gap-${Date.now()}`
        const api = {
            getMessages: vi.fn(async () => latestResponse([
                createMessage('question-1', 1),
                createMessage('answer-3', 3, 'agent'),
            ])),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(state.ranges).toEqual([
            { startSeq: 1, endSeq: 1 },
            { startSeq: 3, endSeq: 3 },
        ])
        expect(state.gaps).toEqual([{ afterSeq: 1, beforeSeq: 3 }])
        expect(state.warning).toMatch(/sequence gap/i)
    })

    it('does not classify an overlapping latest replay as new pending history while reviewing', async () => {
        const sessionId = `session-review-latest-overlap-${Date.now()}`
        const visible = Array.from({ length: 40 }, (_, index) => (
            createMessage(`visible-${index + 61}`, index + 61)
        ))
        const replay = Array.from({ length: 50 }, (_, index) => {
            const seq = index + 51
            return createMessage(seq >= 61 ? `visible-${seq}` : `trimmed-${seq}`, seq)
        })
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(latestResponse(visible))
                .mockResolvedValueOnce(latestResponse(replay)),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, false)
        const visibleReference = getMessageWindowState(sessionId).messages

        expect(await fetchLatestMessages(api as never, sessionId)).toBe(true)

        const state = getMessageWindowState(sessionId)
        expect(state.messages).toBe(visibleReference)
        expect(state.pending).toEqual([])
        expect(state.pendingCount).toBe(0)
        expect(state.hasNewer).toBe(false)
        expect(state.warning).toBeNull()
    })

    it('remembers the server high-water mark after paging older and admits only a genuinely newer replay row', async () => {
        const sessionId = `session-review-latest-high-water-${Date.now()}`
        const latestRows = Array.from({ length: 40 }, (_, index) => (
            createMessage(`row-${index + 61}`, index + 61)
        ))
        const latestPage = latestResponse(latestRows)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        const olderRows = Array.from({ length: 20 }, (_, index) => (
            createMessage(`row-${index + 41}`, index + 41)
        ))
        const replayThrough100 = Array.from({ length: 50 }, (_, index) => (
            createMessage(`row-${index + 51}`, index + 51)
        ))
        const replayThrough101 = [
            ...replayThrough100.slice(1),
            createMessage('row-101', 101),
        ]
        let latestCallCount = 0
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 61) {
                    return directionalResponse(olderRows, 'older', {
                        hasOlder: true,
                        hasNewer: true,
                    })
                }
                latestCallCount += 1
                return latestCallCount === 1
                    ? latestPage
                    : latestCallCount === 2
                        ? latestResponse(replayThrough100)
                        : latestResponse(replayThrough101)
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, false)
        await fetchOlderMessages(api as never, sessionId)
        const reviewedWindow = getMessageWindowState(sessionId)
        const visibleReference = reviewedWindow.messages
        expect([reviewedWindow.oldestSeq, reviewedWindow.newestSeq]).toEqual([41, 80])
        expect(reviewedWindow.hasNewer).toBe(true)

        await fetchLatestMessages(api as never, sessionId)
        let state = getMessageWindowState(sessionId)
        expect(state.messages).toBe(visibleReference)
        expect(state.pending).toEqual([])
        expect(state.pendingCount).toBe(0)
        expect(state.warning).toBeNull()

        await fetchLatestMessages(api as never, sessionId)
        state = getMessageWindowState(sessionId)
        expect(state.messages).toBe(visibleReference)
        expect(state.pending.map((message) => message.id)).toEqual(['row-101'])
        expect(state.pendingCount).toBe(1)
        expect(state.warning).toBeNull()
    })

    it('retries exact latest against the session high-water after newer rows were trimmed from view', async () => {
        const sessionId = `session-exact-latest-high-water-${Date.now()}`
        const initialLatest = Array.from({ length: 40 }, (_, index) => (
            createMessage(`row-${index + 61}`, index + 61)
        ))
        const initialPage = latestResponse(initialLatest)
        initialPage.page.hasMore = true
        initialPage.page.hasOlder = true
        const olderRows = Array.from({ length: 20 }, (_, index) => (
            createMessage(`row-${index + 41}`, index + 41)
        ))
        const staleExact = Array.from({ length: 40 }, (_, index) => (
            createMessage(`row-${index + 51}`, index + 51)
        ))
        const canonicalExact = Array.from({ length: 40 }, (_, index) => (
            createMessage(`row-${index + 62}`, index + 62)
        ))
        let latestCallCount = 0
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 61) {
                    return directionalResponse(olderRows, 'older', {
                        hasOlder: true,
                        hasNewer: true,
                    })
                }
                latestCallCount += 1
                if (latestCallCount === 1) return initialPage
                if (latestCallCount === 2) return latestResponse(staleExact)
                return latestResponse(canonicalExact)
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, false)
        await fetchOlderMessages(api as never, sessionId)
        expect([
            getMessageWindowState(sessionId).oldestSeq,
            getMessageWindowState(sessionId).newestSeq,
        ]).toEqual([41, 80])

        expect(await returnToLatestMessages(api as never, sessionId)).toBe(true)

        const state = getMessageWindowState(sessionId)
        expect(latestCallCount).toBe(3)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 40 }, (_, index) => index + 62),
        )
        expect(state.hasNewer).toBe(false)
        expect(state.gaps).toEqual([])
        expect(state.warning).toBeNull()
        expect(state.atBottom).toBe(true)
    })

    it('ignores an older page that resolves after the window lifecycle was cleared', async () => {
        const sessionId = `session-clear-in-flight-older-${Date.now()}`
        const latestRows = Array.from({ length: 40 }, (_, index) => (
            createMessage(`row-${index + 61}`, index + 61)
        ))
        const latestPage = latestResponse(latestRows)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        let resolveOlder!: (response: MessagesResponse) => void
        const delayedOlder = new Promise<MessagesResponse>((resolve) => {
            resolveOlder = resolve
        })
        const api = {
            getMessages: vi.fn((_sessionId: string, options: { beforeSeq?: number | null }) => (
                options.beforeSeq === 61 ? delayedOlder : Promise.resolve(latestPage)
            )),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const olderFetch = fetchOlderMessages(api as never, sessionId)
        await Promise.resolve()
        clearMessageWindow(sessionId)

        resolveOlder(directionalResponse(
            Array.from({ length: 20 }, (_, index) => createMessage(`row-${index + 41}`, index + 41)),
            'older',
            { hasOlder: true, hasNewer: true },
        ))
        await olderFetch

        const state = getMessageWindowState(sessionId)
        expect(state.messages).toEqual([])
        expect(state.isLoadingOlder).toBe(false)
        expect(state.warning).toBeNull()
    })

    it('still reconciles a reviewed optimistic row when latest returns an older persisted echo', async () => {
        const sessionId = `session-review-latest-local-id-${Date.now()}`
        const visible = Array.from({ length: 40 }, (_, index) => (
            createMessage(`visible-${index + 61}`, index + 61)
        ))
        const localId = 'local-reviewed-send'
        const storedEcho = {
            ...createMessage('stored-reviewed-send', 60),
            localId,
        }
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(latestResponse(visible))
                .mockResolvedValueOnce(latestResponse([storedEcho, ...visible])),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, {
            ...createMessage(localId, 101),
            id: localId,
            seq: null,
            localId,
            status: 'sending' as const,
        })
        setAtBottom(sessionId, false)

        expect(await fetchLatestMessages(api as never, sessionId)).toBe(true)

        const state = getMessageWindowState(sessionId)
        expect([...state.messages, ...state.pending]
            .filter((message) => message.localId === localId)
            .map((message) => message.id)).toEqual(['stored-reviewed-send'])
        expect(state.pendingCount).toBe(1)
        expect(state.warning).toBeNull()
    })

    it('loads older and newer complete turns without duplicates or silent gaps', async () => {
        const sessionId = `session-bidirectional-${Date.now()}`
        const allTurns = createTurns(41)
        const latestFortyTurns = allTurns.slice(2)
        const oldestTurn = allTurns.slice(0, 2)
        const newestTurn = allTurns.slice(-2)
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 3) {
                    return directionalResponse(oldestTurn, 'older', {
                        hasOlder: false,
                        hasNewer: true,
                    })
                }
                if (options.afterSeq === 80) {
                    return directionalResponse(newestTurn, 'newer', {
                        hasOlder: true,
                        hasNewer: false,
                    })
                }
                return {
                    ...latestResponse(latestFortyTurns),
                    page: {
                        ...latestResponse(latestFortyTurns).page,
                        hasMore: true,
                        hasOlder: true,
                    },
                }
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        await fetchOlderMessages(api as never, sessionId)

        let state = getMessageWindowState(sessionId)
        expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({
            beforeSeq: 3,
        }))
        expect(state.messages[0]?.id).toBe('user-1')
        expect(state.messages.at(-1)?.id).toBe('answer-40')
        expect(state.hasOlder).toBe(false)
        expect(state.hasNewer).toBe(true)
        expect(state.gaps).toEqual([])

        await fetchNewerMessages(api as never, sessionId)

        state = getMessageWindowState(sessionId)
        expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({
            afterSeq: 80,
        }))
        expect(state.messages[0]?.id).toBe('user-2')
        expect(state.messages.at(-1)?.id).toBe('answer-41')
        expect(state.hasOlder).toBe(true)
        expect(state.hasNewer).toBe(false)
        expect(state.gaps).toEqual([])
        expect(new Set(state.messages.map((message) => message.id)).size).toBe(state.messages.length)
    })

    it('publishes a directional history commit without waiting for the streaming throttle', async () => {
        vi.useFakeTimers()
        const sessionId = `session-immediate-history-${Date.now()}`
        const latest = Array.from({ length: 20 }, (_, index) => (
            createMessage(`turn-${index + 21}`, index + 21)
        ))
        const older = Array.from({ length: 20 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const latestPage = latestResponse(latest)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(latestPage)
                .mockResolvedValueOnce(directionalResponse(older, 'older', {
                    hasOlder: false,
                    hasNewer: true,
                })),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const observedOldestSeqs: Array<number | null> = []
        const unsubscribe = subscribeMessageWindow(sessionId, () => {
            observedOldestSeqs.push(getMessageWindowState(sessionId).oldestSeq)
        })

        try {
            await fetchOlderMessages(api as never, sessionId)
            expect(observedOldestSeqs).toContain(1)
        } finally {
            unsubscribe()
            vi.runOnlyPendingTimers()
            vi.useRealTimers()
        }
    })

    it('keeps live mode after an under-capacity older merge still contains the latest turn', async () => {
        const sessionId = `session-under-capacity-older-${Date.now()}`
        const latest = Array.from({ length: 20 }, (_, index) => (
            createMessage(`turn-${index + 21}`, index + 21)
        ))
        const older = Array.from({ length: 10 }, (_, index) => (
            createMessage(`turn-${index + 11}`, index + 11)
        ))
        const latestPage = latestResponse(latest)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(latestPage)
                .mockResolvedValueOnce(directionalResponse(older, 'older', {
                    hasOlder: true,
                    hasNewer: true,
                })),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        await fetchOlderMessages(api as never, sessionId)

        let state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 30 }, (_, index) => index + 11),
        )
        expect(state.hasNewer).toBe(false)

        setAtBottom(sessionId, true)
        ingestIncomingMessages(sessionId, [createMessage('live-turn-41', 41, 'agent')])

        state = getMessageWindowState(sessionId)
        expect(state.messages.at(-1)?.id).toBe('live-turn-41')
        expect(state.pending).toEqual([])
        expect(state.pendingCount).toBe(0)
    })

    it('keeps the start boundary after an under-capacity newer merge still contains the oldest turn', async () => {
        const sessionId = `session-under-capacity-newer-${Date.now()}`
        const oldest = Array.from({ length: 20 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const newer = Array.from({ length: 10 }, (_, index) => (
            createMessage(`turn-${index + 21}`, index + 21)
        ))
        const historicalPage = latestResponse(oldest)
        historicalPage.page.hasNewer = true
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(historicalPage)
                .mockResolvedValueOnce(directionalResponse(newer, 'newer', {
                    hasOlder: true,
                    hasNewer: true,
                })),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        await fetchNewerMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 30 }, (_, index) => index + 1),
        )
        expect(state.hasOlder).toBe(false)
        expect(state.hasNewer).toBe(true)
    })

    it('marks a live-trimmed oldest turn as reachable history', async () => {
        const sessionId = `session-live-trim-history-${Date.now()}`
        const firstForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(latestResponse(firstForty))
                .mockResolvedValueOnce(directionalResponse([
                    createMessage('turn-1', 1),
                ], 'older', { hasOlder: false, hasNewer: true })),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, true)
        ingestIncomingMessages(sessionId, [createMessage('turn-41', 41)])

        let state = getMessageWindowState(sessionId)
        expect(state.messages[0]?.seq).toBe(2)
        expect(state.messages.at(-1)?.seq).toBe(41)
        expect(state.hasOlder).toBe(true)

        await fetchOlderMessages(api as never, sessionId)

        state = getMessageWindowState(sessionId)
        expect(api.getMessages).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({
            beforeSeq: 2,
        }))
        expect(state.messages[0]?.seq).toBe(1)
        expect(state.messages.at(-1)?.seq).toBe(40)
        expect(state.hasOlder).toBe(false)
        expect(state.hasNewer).toBe(true)
        expect(state.gaps).toEqual([])
    })

    it('marks a turn dropped by an optimistic append as reachable history', async () => {
        const sessionId = `session-optimistic-trim-history-${Date.now()}`
        const firstForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const api = {
            getMessages: vi.fn(async () => latestResponse(firstForty)),
            markSessionRead: vi.fn(async () => {}),
        }
        const optimistic = {
            ...createMessage('local-turn-41', 41),
            localId: 'local-turn-41',
        }

        await fetchLatestMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, optimistic)

        const state = getMessageWindowState(sessionId)
        expect(state.messages[0]?.seq).toBe(2)
        expect(state.messages.at(-1)?.id).toBe('local-turn-41')
        expect(state.hasOlder).toBe(true)
        expect(state.gaps).toEqual([])
    })

    it('keeps a sequence-less optimistic send reachable when the client clock sorts before persisted history', async () => {
        const sessionId = `session-optimistic-clock-skew-${Date.now()}`
        const firstForty = Array.from({ length: 40 }, (_, index) => ({
            ...createMessage(`turn-${index + 1}`, index + 1),
            createdAt: 1_000 + index,
        }))
        const api = {
            getMessages: vi.fn(async () => latestResponse(firstForty)),
            markSessionRead: vi.fn(async () => {}),
        }
        const optimistic = {
            ...createMessage('local-skewed-turn', 41),
            seq: null,
            localId: 'local-skewed-turn',
            createdAt: 0,
            status: 'sending' as const,
        }

        await fetchLatestMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, optimistic)

        const state = getMessageWindowState(sessionId)
        expect(state.messages.at(-1)?.id).toBe('local-skewed-turn')
        expect([...state.messages, ...state.pending].filter((message) => (
            message.localId === 'local-skewed-turn'
        ))).toHaveLength(1)
        expect(state.hasOlder).toBe(true)
    })

    it('keeps every unmatched optimistic send outside the evictable visible-turn capacity', () => {
        const sessionId = `session-optimistic-visible-cap-${Date.now()}`

        for (let index = 0; index < 41; index += 1) {
            appendOptimisticMessage(sessionId, {
                ...createMessage(`local-${index + 1}`, index + 1),
                seq: null,
                localId: `local-${index + 1}`,
                status: 'sending' as const,
            })
        }

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.id)).toEqual(
            Array.from({ length: 41 }, (_, index) => `local-${index + 1}`),
        )
        expect(state.pending).toEqual([])
        expect(state.hasOlder).toBe(false)
    })

    it('ignores an older response when an optimistic append changes its request cursor', async () => {
        const sessionId = `session-optimistic-older-race-${Date.now()}`
        const latestForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 61}`, index + 61)
        ))
        const latestPage = latestResponse(latestForty)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        let resolveStaleOlder!: (response: MessagesResponse) => void
        const staleOlderPage = new Promise<MessagesResponse>((resolve) => {
            resolveStaleOlder = resolve
        })
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 61) {
                    return await staleOlderPage
                }
                return latestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }
        const optimistic = {
            ...createMessage('local-turn-101', 101),
            localId: 'local-turn-101',
            status: 'sending' as const,
        }

        await fetchLatestMessages(api as never, sessionId)
        const staleFetch = fetchOlderMessages(api as never, sessionId)
        await vi.waitFor(() => {
            expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({
                beforeSeq: 61,
            }))
        })
        appendOptimisticMessage(sessionId, optimistic)
        resolveStaleOlder(directionalResponse(
            Array.from({ length: 20 }, (_, index) => (
                createMessage(`turn-${index + 41}`, index + 41)
            )),
            'older',
            { hasOlder: true, hasNewer: true },
        ))
        await staleFetch

        let state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 40 }, (_, index) => index + 62),
        )
        expect(state.messages.at(-1)?.id).toBe('local-turn-101')
        expect(state.gaps).toEqual([])
    })

    it('ignores an older response when a live SSE row changes its request cursor', async () => {
        const sessionId = `session-live-older-race-${Date.now()}`
        const latestForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 61}`, index + 61)
        ))
        const latestPage = latestResponse(latestForty)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        let resolveStaleOlder!: (response: MessagesResponse) => void
        const staleOlderPage = new Promise<MessagesResponse>((resolve) => {
            resolveStaleOlder = resolve
        })
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
            }) => options.beforeSeq === 61 ? await staleOlderPage : latestPage),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        const staleFetch = fetchOlderMessages(api as never, sessionId)
        await vi.waitFor(() => {
            expect(api.getMessages).toHaveBeenCalledWith(sessionId, expect.objectContaining({ beforeSeq: 61 }))
        })
        ingestIncomingMessages(sessionId, [createMessage('live-turn-101', 101)])
        resolveStaleOlder(directionalResponse(
            Array.from({ length: 20 }, (_, index) => createMessage(`turn-${index + 41}`, index + 41)),
            'older',
            { hasOlder: true, hasNewer: true },
        ))
        await staleFetch

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 40 }, (_, index) => index + 62),
        )
        expect(state.messages.at(-1)?.id).toBe('live-turn-101')
        expect(state.gaps).toEqual([])
    })

    it('moves a local-only optimistic tail to pending when a valid older page trims it', async () => {
        const sessionId = `session-optimistic-older-trim-${Date.now()}`
        const firstForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const latestPage = latestResponse(firstForty)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
            }) => {
                if (options.beforeSeq === 2) {
                    return directionalResponse([
                        createMessage('turn-1', 1),
                    ], 'older', { hasOlder: false, hasNewer: true })
                }
                return latestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }
        const optimistic = {
            ...createMessage('local-turn-41', 41),
            localId: 'local-turn-41',
            status: 'sending' as const,
        }

        await fetchLatestMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, optimistic)
        await fetchOlderMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(api.getMessages).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({
            beforeSeq: 2,
        }))
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 40 }, (_, index) => index + 1),
        )
        expect(state.pending.map((message) => message.id)).toEqual(['local-turn-41'])
        expect(state.hasNewer).toBe(true)
        expect(state.gaps).toEqual([])
    })

    it('keeps a local-only optimistic tail when historical paging fills an already-full pending window', async () => {
        const sessionId = `session-optimistic-pending-cap-${Date.now()}`
        const firstForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const latestPage = latestResponse(firstForty)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        latestPage.page.hasNewer = true
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
            }) => {
                if (options.beforeSeq === 2) {
                    return directionalResponse([
                        createMessage('turn-1', 1),
                    ], 'older', { hasOlder: false, hasNewer: true })
                }
                return latestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }
        const optimistic = {
            ...createMessage('local-turn-41', 41),
            seq: null,
            localId: 'local-turn-41',
            createdAt: 1_000,
            status: 'sending' as const,
        }

        await fetchLatestMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, optimistic)
        ingestIncomingMessages(sessionId, Array.from({ length: 8 }, (_, index) => ({
            ...createMessage(`live-${index + 1}`, 41 + index),
            createdAt: 2_000 + index,
        })))
        expect(getMessageWindowState(sessionId).pending).toHaveLength(8)

        await fetchOlderMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: 40 }, (_, index) => index + 1),
        )
        expect(state.pending.map((message) => message.id)).toEqual([
            ...Array.from({ length: 8 }, (_, index) => `live-${index + 1}`),
            'local-turn-41',
        ])
        expect(state.hasNewer).toBe(true)
        expect(state.gaps).toEqual([])
    })

    it('keeps the newer boundary while a local-only optimistic row waits in pending', async () => {
        const sessionId = `session-optimistic-pending-boundary-${Date.now()}`
        const firstForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const latestPage = latestResponse(firstForty)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 2) {
                    return directionalResponse([
                        createMessage('turn-1', 1),
                    ], 'older', { hasOlder: false, hasNewer: true })
                }
                if (options.afterSeq === 40) {
                    return directionalResponse([], 'newer', { hasOlder: true, hasNewer: false })
                }
                return latestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, {
            ...createMessage('local-turn-41', 41),
            localId: 'local-turn-41',
            status: 'sending' as const,
        })
        await fetchOlderMessages(api as never, sessionId)
        await fetchNewerMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(state.pending.map((message) => message.id)).toEqual(['local-turn-41'])
        expect(state.hasNewer).toBe(true)
        expect(state.gaps).toEqual([])
    })

    it('reconciles a pending optimistic row when a newer page returns its persisted localId echo', async () => {
        const sessionId = `session-optimistic-pending-newer-echo-${Date.now()}`
        const firstForty = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const latestPage = latestResponse(firstForty)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        const storedEcho = {
            ...createMessage('stored-turn-41', 41),
            localId: 'local-turn-41',
        }
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
                afterSeq?: number | null
            }) => {
                if (options.beforeSeq === 2) {
                    return directionalResponse([
                        createMessage('turn-1', 1),
                    ], 'older', { hasOlder: false, hasNewer: true })
                }
                if (options.afterSeq === 40) {
                    return directionalResponse([storedEcho], 'newer', {
                        hasOlder: true,
                        hasNewer: false,
                    })
                }
                return latestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, {
            ...createMessage('local-turn-41', 41),
            seq: null,
            localId: 'local-turn-41',
            status: 'sending' as const,
        })
        await fetchOlderMessages(api as never, sessionId)
        expect(getMessageWindowState(sessionId).pending.map((message) => message.id)).toEqual([
            'local-turn-41',
        ])

        await fetchNewerMessages(api as never, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(state.messages.at(-1)?.id).toBe('stored-turn-41')
        expect(state.pending).toEqual([])
        expect(state.pendingCount).toBe(0)
        expect(state.hasNewer).toBe(false)
        expect(state.gaps).toEqual([])
    })

    it('reconciles a visible optimistic row when its persisted SSE echo enters pending', async () => {
        const sessionId = `session-visible-optimistic-pending-echo-${Date.now()}`
        const latestRows = Array.from({ length: 40 }, (_, index) => (
            createMessage(`turn-${index + 1}`, index + 1)
        ))
        const latestPage = latestResponse(latestRows)
        latestPage.page.hasMore = true
        latestPage.page.hasOlder = true
        const storedEcho = {
            ...createMessage('stored-turn-41', 41),
            localId: 'local-turn-41',
        }
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                beforeSeq?: number | null
            }) => {
                if (options.beforeSeq === 1) {
                    return directionalResponse([
                        createMessage('turn-0', 0),
                    ], 'older', { hasOlder: false, hasNewer: true })
                }
                return latestPage
            }),
            markSessionRead: vi.fn(async () => {}),
        }

        await fetchLatestMessages(api as never, sessionId)
        await fetchOlderMessages(api as never, sessionId)
        appendOptimisticMessage(sessionId, {
            ...createMessage('local-turn-41', 41),
            seq: null,
            localId: 'local-turn-41',
            createdAt: 1_000,
            status: 'sending' as const,
        })

        ingestIncomingMessages(sessionId, [storedEcho])

        const state = getMessageWindowState(sessionId)
        expect([...state.messages, ...state.pending].filter((message) => (
            message.localId === 'local-turn-41'
        )).map((message) => message.id)).toEqual(['stored-turn-41'])
        expect(state.messages.some((message) => message.id === 'local-turn-41')).toBe(false)
        expect(state.pending.map((message) => message.id)).toContain('stored-turn-41')
    })

    it('keeps every one-row turn reachable with an overlapping anchor across directional pages', async () => {
        const sessionId = `session-single-row-turns-${Date.now()}`
        const rows = Array.from({ length: 100 }, (_, index) => (
            createMessage(`single-row-turn-${index + 1}`, index + 1)
        ))
        const api = {
            getMessages: vi.fn(async (_sessionId: string, options: {
                limit: number
                beforeSeq?: number | null
                afterSeq?: number | null
            }): Promise<MessagesResponse> => {
                const direction = options.beforeSeq !== null && options.beforeSeq !== undefined
                    ? 'older'
                    : options.afterSeq !== null && options.afterSeq !== undefined
                        ? 'newer'
                        : 'latest'
                const eligible = direction === 'older'
                    ? rows.filter((message) => message.seq! < options.beforeSeq!)
                    : direction === 'newer'
                        ? rows.filter((message) => message.seq! > options.afterSeq!)
                        : rows
                const messages = direction === 'newer'
                    ? eligible.slice(0, options.limit)
                    : eligible.slice(-options.limit)
                const startSeq = messages[0]?.seq ?? null
                const endSeq = messages.at(-1)?.seq ?? null
                const hasOlder = startSeq !== null && startSeq > 1
                const hasNewer = endSeq !== null && endSeq < rows.length
                return {
                    messages,
                    page: {
                        limit: options.limit,
                        direction,
                        beforeSeq: options.beforeSeq ?? null,
                        afterSeq: options.afterSeq ?? null,
                        nextBeforeSeq: startSeq,
                        nextAfterSeq: endSeq,
                        hasMore: hasOlder,
                        hasOlder,
                        hasNewer,
                        range: startSeq === null || endSeq === null ? null : { startSeq, endSeq },
                        startComplete: true,
                        endComplete: true,
                        continuation: null,
                    },
                }
            }),
            markSessionRead: vi.fn(async () => {}),
        }
        const visited = new Set<number>()
        const capture = () => {
            const state = getMessageWindowState(sessionId)
            const seqs = state.messages
                .map((message) => message.seq)
                .filter((seq): seq is number => typeof seq === 'number')
            for (const seq of seqs) visited.add(seq)
            expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => seqs[0]! + index))
            expect(state.gaps).toEqual([])
            return { state, seqs }
        }

        await fetchLatestMessages(api as never, sessionId)
        let current = capture()
        expect(current.seqs).toEqual(Array.from({ length: 40 }, (_, index) => index + 61))

        while (current.state.hasOlder) {
            const retainedAnchor = current.state.oldestSeq
            await fetchOlderMessages(api as never, sessionId)
            current = capture()
            expect(current.seqs).toContain(retainedAnchor)
        }
        expect(current.seqs).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
        expect([...visited].sort((left, right) => left - right)).toEqual(
            Array.from({ length: 100 }, (_, index) => index + 1),
        )

        while (current.state.hasNewer) {
            const retainedAnchor = current.state.newestSeq
            await fetchNewerMessages(api as never, sessionId)
            current = capture()
            expect(current.seqs).toContain(retainedAnchor)
        }
        expect(current.seqs).toEqual(Array.from({ length: 40 }, (_, index) => index + 61))

        const directionalRequests = api.getMessages.mock.calls
            .map(([, options]) => options)
            .filter((options) => options.beforeSeq !== null || options.afterSeq !== null)
        expect(directionalRequests).toHaveLength(6)
        expect(directionalRequests.every((options) => options.limit === 20)).toBe(true)
    })

    it('keeps the visible window reference and order stable while 1,000 agent events arrive during review', async () => {
        const sessionId = `session-live-isolation-${Date.now()}`
        const visible = [
            createMessage('visible-question', 1),
            createMessage('visible-answer', 2, 'agent'),
        ]
        const api = {
            getMessages: vi.fn(async () => latestResponse(visible)),
            markSessionRead: vi.fn(async () => {}),
        }
        await fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, false)
        const before = getMessageWindowState(sessionId)
        const visibleReference = before.messages
        const visibleIds = before.messages.map((message) => message.id)
        const incoming = Array.from({ length: 1_000 }, (_, index) => (
            createMessage(`live-agent-event-${index}`, index + 3, 'agent')
        ))

        ingestIncomingMessages(sessionId, incoming)

        const after = getMessageWindowState(sessionId)
        expect(after.messages).toBe(visibleReference)
        expect(after.messages.map((message) => message.id)).toEqual(visibleIds)
        expect(after.pending).toHaveLength(1_000)
        expect(after.pendingCount).toBe(1_000)
        expect(after.atBottom).toBe(false)
    })

    it('drops pending overflow only at turn boundaries and requires an exact refresh before flush', async () => {
        const sessionId = `session-pending-overflow-${Date.now()}`
        const visible = [
            createMessage('visible-question', 1),
            createMessage('visible-answer', 2, 'agent'),
        ]
        const api = {
            getMessages: vi.fn(async () => latestResponse(visible)),
            markSessionRead: vi.fn(async () => {}),
        }
        await fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, false)

        ingestIncomingMessages(sessionId, createTurns(9).map((message) => ({
            ...message,
            id: `pending-${message.id}`,
            seq: (message.seq ?? 0) + 2,
            createdAt: message.createdAt + 2,
        })))

        const beforeFlush = getMessageWindowState(sessionId)
        const visibleReference = beforeFlush.messages
        const pendingReference = beforeFlush.pending
        expect(beforeFlush.pending.map((message) => message.id)).toEqual(
            createTurns(8).map((message) => `pending-${message.id.replace(/-(\d+)$/, (_, value) => `-${Number(value) + 1}`)}`),
        )
        expect(beforeFlush.pendingCount).toBe(18)
        expect(beforeFlush.warning).toMatch(/refresh/i)

        expect(flushPendingMessages(sessionId)).toBe(true)
        const afterFlush = getMessageWindowState(sessionId)
        expect(afterFlush.messages).toBe(visibleReference)
        expect(afterFlush.pending).toBe(pendingReference)
    })

    it('does not count the same pending overflow rows twice when reconnect latest replays them', async () => {
        const sessionId = `session-pending-overflow-replay-${Date.now()}`
        const visible = [
            createMessage('visible-question', 1),
            createMessage('visible-answer', 2, 'agent'),
        ]
        const replayedTurns = createTurns(9).map((message) => ({
            ...message,
            id: `replayed-${message.id}`,
            seq: (message.seq ?? 0) + 2,
            createdAt: message.createdAt + 2,
        }))
        const api = {
            getMessages: vi.fn()
                .mockResolvedValueOnce(latestResponse(visible))
                .mockResolvedValueOnce(latestResponse(replayedTurns))
                .mockResolvedValueOnce(latestResponse(replayedTurns)),
            markSessionRead: vi.fn(async () => {}),
        }
        await fetchLatestMessages(api as never, sessionId)
        setAtBottom(sessionId, false)

        await fetchLatestMessages(api as never, sessionId)
        const afterFirstDelivery = getMessageWindowState(sessionId)
        const pendingIds = afterFirstDelivery.pending.map((message) => message.id)
        expect(afterFirstDelivery.pendingCount).toBe(18)

        await fetchLatestMessages(api as never, sessionId)

        const afterReplay = getMessageWindowState(sessionId)
        expect(afterReplay.pending.map((message) => message.id)).toEqual(pendingIds)
        expect(afterReplay.pendingCount).toBe(18)
        expect(afterReplay.warning).toMatch(/refresh/i)
    })
})
