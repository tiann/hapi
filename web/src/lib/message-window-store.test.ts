import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import {
    HISTORY_WINDOW_SIZE,
    VISIBLE_WINDOW_SIZE,
    activateMessageWindow,
    appendOptimisticMessage,
    clearMessageWindow,
    fetchOlderMessages,
    getMessageWindowState,
    getQueuedReconcileCandidateLocalIds,
    ingestIncomingMessages,
    markMessagesConsumed,
    reconcileQueuedLocalIds,
    removeOptimisticMessage,
    beginNavigation,
    setMessageViewMode,
    syncTailMessages,
    updateMessageStatus,
} from '@/lib/message-window-store'

const touchedSessions = new Set<string>()

function sessionId(name: string): string {
    const id = `message-window-v2-${name}`
    touchedSessions.add(id)
    return id
}

function makeUserMessage(props: {
    id: string
    seq?: number | null
    localId?: string | null
    createdAt?: number
    invokedAt?: number | null
    status?: DecryptedMessage['status']
    scheduledAt?: number | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq ?? null,
        localId: props.localId ?? null,
        content: {
            role: 'user',
            content: { type: 'text', text: props.id }
        },
        createdAt: props.createdAt ?? 1_000,
        invokedAt: props.invokedAt,
        scheduledAt: props.scheduledAt,
        status: props.status,
        originalText: props.id
    } as DecryptedMessage
}

function makeAgentMessage(props: {
    id: string
    seq: number
    at: number
    invokedAt?: number | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: props.id }
            }
        },
        createdAt: props.at,
        invokedAt: props.invokedAt !== undefined ? props.invokedAt : props.at
    } as DecryptedMessage
}

function makeHiddenAgentMessage(props: { id: string; seq: number; at: number }): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'system', isMeta: true }
            }
        },
        createdAt: props.at,
        invokedAt: props.at
    } as DecryptedMessage
}

function makeReasoningMessage(id: string, streamId: string, seq: number, at: number, live = true): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'reasoning', message: id, id: streamId, ...(live ? { live: true } : {}) }
            }
        },
        createdAt: at,
        invokedAt: at
    } as DecryptedMessage
}

function makeAgentRunMessage(
    id: string,
    seq: number,
    at: number,
    type: 'agent-run-start' | 'agent-run-update' | 'agent-run-trace' = 'agent-run-update'
): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type,
                    cardId: 'card-1',
                    agentId: 'agent-1',
                    status: 'running',
                    activity: id
                }
            }
        },
        createdAt: at,
        invokedAt: at
    } as DecryptedMessage
}

function latestResponse(
    messages: DecryptedMessage[],
    options: {
        epoch?: number
        hasMore?: boolean
        reset?: boolean
        nextBeforeAt?: number | null
        nextBeforeSeq?: number | null
        snapshotHeadAt?: number | null
        snapshotHeadSeq?: number | null
    } = {}
): MessagesResponse {
    const newest = [...messages]
        .filter((message) => typeof message.seq === 'number')
        .sort((left, right) => (left.invokedAt ?? left.createdAt) - (right.invokedAt ?? right.createdAt))
        .at(-1)
    return {
        messages,
        page: {
            direction: 'latest',
            limit: 200,
            epoch: options.epoch ?? 0,
            reset: options.reset ?? false,
            nextBeforeAt: options.nextBeforeAt ?? null,
            nextBeforeSeq: options.nextBeforeSeq ?? null,
            nextAfterAt: null,
            nextAfterSeq: null,
            snapshotHeadAt: options.snapshotHeadAt
                ?? (newest ? newest.invokedAt ?? newest.createdAt : null),
            snapshotHeadSeq: options.snapshotHeadSeq
                ?? (typeof newest?.seq === 'number' ? newest.seq : null),
            hasMore: options.hasMore ?? false
        }
    }
}

function afterResponse(
    messages: DecryptedMessage[],
    options: {
        epoch?: number
        hasMore?: boolean
        nextAfterAt: number
        nextAfterSeq: number
        snapshotHeadAt: number
        snapshotHeadSeq: number
    }
): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'after',
            limit: 200,
            epoch: options.epoch ?? 0,
            reset: false,
            nextBeforeAt: null,
            nextBeforeSeq: null,
            nextAfterAt: options.nextAfterAt,
            nextAfterSeq: options.nextAfterSeq,
            snapshotHeadAt: options.snapshotHeadAt,
            snapshotHeadSeq: options.snapshotHeadSeq,
            hasMore: options.hasMore ?? false
        }
    }
}

function beforeResponse(
    messages: DecryptedMessage[],
    options: {
        epoch?: number
        hasMore?: boolean
        nextBeforeAt: number | null
        nextBeforeSeq: number | null
    }
): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'before',
            limit: 200,
            epoch: options.epoch ?? 0,
            reset: false,
            nextBeforeAt: options.nextBeforeAt,
            nextBeforeSeq: options.nextBeforeSeq,
            nextAfterAt: null,
            nextAfterSeq: null,
            snapshotHeadAt: null,
            snapshotHeadSeq: null,
            hasMore: options.hasMore ?? false
        }
    }
}

function createApi(getMessages: ApiClient['getMessages']): ApiClient {
    return { getMessages } as ApiClient
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

afterEach(() => {
    for (const id of touchedSessions) {
        clearMessageWindow(id)
    }
    touchedSessions.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
})

describe('message tail synchronization', () => {
    it('renders a persisted window immediately, then requests the latest tail on re-entry', async () => {
        const id = sessionId('reentry')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['cached'])
        setMessageViewMode(id, 'history')
        activateMessageWindow(id)
        expect(getMessageWindowState(id).viewMode).toBe('tail')

        const latest = makeAgentMessage({ id: 'latest', seq: 2_040, at: 2_040_000 })
        const getMessages = vi.fn(async () => latestResponse([latest], {
            epoch: 3,
            hasMore: true,
            nextBeforeAt: 1_841_000,
            nextBeforeSeq: 1_841
        }))
        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: 200 })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])
        expect(getMessageWindowState(id).hasMore).toBe(true)
        expect('pending' in getMessageWindowState(id)).toBe(false)
    })

    it('preserves queued rows while replacing stale server rows on re-entry', async () => {
        const id = sessionId('reentry-queued')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 4_000 })
        const queued = makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 4_100,
            invokedAt: null,
            status: 'queued'
        })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached, queued],
            hasMore: true,
            oldestPositionAt: 4_000,
            oldestPositionSeq: 40,
            newestPositionAt: 4_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        activateMessageWindow(id)
        const latest = makeAgentMessage({ id: 'latest', seq: 2_000, at: 200_000 })
        const getMessages = vi.fn(async () => latestResponse([latest], { epoch: 3 }))
        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: 200 })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'local-1',
            'latest'
        ])
        expect(getMessageWindowState(id).messages).toContainEqual(expect.objectContaining({
            id: 'local-1',
            status: 'queued'
        }))
    })

    it('keeps incremental synchronization for non-activation refreshes', async () => {
        const id = sessionId('incremental-refresh')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        const latest = makeAgentMessage({ id: 'latest', seq: 41, at: 41_000 })
        const getMessages = vi.fn(async () => afterResponse([latest], {
            epoch: 3,
            nextAfterAt: 41_000,
            nextAfterSeq: 41,
            snapshotHeadAt: 41_000,
            snapshotHeadSeq: 41
        }))
        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, {
            afterAt: 40_000,
            afterSeq: 40,
            untilAt: null,
            untilSeq: null,
            epoch: 3,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'cached',
            'latest'
        ])
    })

    it('preserves SSE rows that arrive while the latest snapshot is in flight', async () => {
        const id = sessionId('latest-sse-race')
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await response.promise)
        const syncing = syncTailMessages(createApi(getMessages), id)

        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 2, at: 2_000 })
        ])
        response.resolve(latestResponse([
            makeAgentMessage({ id: 'snapshot', seq: 1, at: 1_000 })
        ], { epoch: 1 }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'snapshot',
            'concurrent'
        ])
        expect(getMessageWindowState(id).newestSeq).toBe(2)
    })

    it('reconciles an optimistic send echoed by an in-flight latest response', async () => {
        const id = sessionId('latest-optimistic-echo')
        const response = deferred<MessagesResponse>()
        const syncing = syncTailMessages(createApi(vi.fn(async () => await response.promise)), id)
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 1_000,
            invokedAt: null,
            status: 'sending'
        }))

        response.resolve(latestResponse([
            makeUserMessage({
                id: 'server-1',
                seq: 1,
                localId: 'local-1',
                createdAt: 1_000,
                invokedAt: null
            })
        ], { epoch: 1 }))
        await syncing

        expect(getMessageWindowState(id).messages).toEqual([
            expect.objectContaining({
                id: 'server-1',
                localId: 'local-1',
                status: 'sending'
            })
        ])
    })

    it('uses the oldest retained row after a latest and SSE merge trims the window', async () => {
        const id = sessionId('latest-sse-trim-cursor')
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await response.promise)
            .mockResolvedValueOnce(beforeResponse([], {
                epoch: 1,
                hasMore: false,
                nextBeforeAt: null,
                nextBeforeSeq: null
            }))
        const api = createApi(getMessages)
        const syncing = syncTailMessages(api, id)

        ingestIncomingMessages(id, Array.from({ length: 450 }, (_, index) => {
            const seq = index + 201
            return makeAgentMessage({ id: `concurrent-${seq}`, seq, at: seq })
        }))
        response.resolve(latestResponse(
            Array.from({ length: 200 }, (_, index) => {
                const seq = index + 1
                return makeAgentMessage({ id: `snapshot-${seq}`, seq, at: seq })
            }),
            {
                epoch: 1,
                hasMore: false,
                nextBeforeAt: 1,
                nextBeforeSeq: 1
            }
        ))
        await syncing

        await fetchOlderMessages(api, id)

        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            beforeAt: 251,
            beforeSeq: 251,
            limit: 200
        })
    })

    it('commits each forward page before the next page resolves', async () => {
        const id = sessionId('page-commit')
        const initial = makeAgentMessage({ id: 'initial', seq: 1, at: 1_000 })
        const firstDelta = makeAgentMessage({ id: 'delta-1', seq: 2, at: 2_000 })
        const secondDelta = makeAgentMessage({ id: 'delta-2', seq: 3, at: 3_000 })
        const secondPage = deferred<MessagesResponse>()
        let call = 0
        const getMessages = vi.fn(async () => {
            call += 1
            if (call === 1) return latestResponse([initial], { epoch: 1 })
            if (call === 2) {
                return afterResponse([firstDelta], {
                    epoch: 1,
                    nextAfterAt: 2_000,
                    nextAfterSeq: 2,
                    snapshotHeadAt: 3_000,
                    snapshotHeadSeq: 3,
                    hasMore: true
                })
            }
            return await secondPage.promise
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => {
            expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('delta-1')
            expect(getMessages).toHaveBeenCalledTimes(3)
        })
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)

        secondPage.resolve(afterResponse([secondDelta], {
            epoch: 1,
            nextAfterAt: 3_000,
            nextAfterSeq: 3,
            snapshotHeadAt: 3_000,
            snapshotHeadSeq: 3
        }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'initial',
            'delta-1',
            'delta-2'
        ])
    })

    it('keeps the newest SSE cursor when a forward page finishes behind it', async () => {
        const id = sessionId('forward-sse-cursor')
        const initial = makeAgentMessage({ id: 'initial', seq: 10, at: 1_000 })
        const stalePage = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([initial], { epoch: 5 }))
            .mockImplementationOnce(async () => await stalePage.promise)
            .mockResolvedValueOnce(afterResponse([], {
                epoch: 5,
                nextAfterAt: 1_200,
                nextAfterSeq: 12,
                snapshotHeadAt: 1_200,
                snapshotHeadSeq: 12
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 12, at: 1_200 })
        ])
        stalePage.resolve(afterResponse([
            makeAgentMessage({ id: 'page', seq: 11, at: 1_100 })
        ], {
            epoch: 5,
            nextAfterAt: 1_100,
            nextAfterSeq: 11,
            snapshotHeadAt: 1_100,
            snapshotHeadSeq: 11
        }))
        await syncing

        await syncTailMessages(api, id)

        expect(getMessages.mock.calls[2]?.[1]).toEqual({
            afterAt: 1_200,
            afterSeq: 12,
            untilAt: null,
            untilSeq: null,
            epoch: 5,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'initial',
            'page',
            'concurrent'
        ])
    })

    it('invalidates an in-flight incremental request when re-entry prioritizes latest', async () => {
        const id = sessionId('reentry-in-flight')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3
        }))

        const staleResponse = deferred<MessagesResponse>()
        const latest = makeAgentMessage({ id: 'latest', seq: 2_040, at: 2_040_000 })
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await staleResponse.promise)
            .mockResolvedValueOnce(latestResponse([latest], { epoch: 3 }))
        const api = createApi(getMessages)
        const initialSync = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1))

        activateMessageWindow(id)
        const reentrySync = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        expect(getMessages.mock.calls[1]?.[1]).toEqual({ limit: 200 })
        staleResponse.resolve(afterResponse([
            makeAgentMessage({ id: 'stale-page', seq: 41, at: 41_000 })
        ], {
            epoch: 3,
            nextAfterAt: 41_000,
            nextAfterSeq: 41,
            snapshotHeadAt: 2_040_000,
            snapshotHeadSeq: 2_040,
            hasMore: true
        }))

        await initialSync
        await reentrySync

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])
    })

    it('deduplicates SSE and REST delivery while preserving the authoritative invocation timestamp', async () => {
        const id = sessionId('dedupe')
        const initial = makeAgentMessage({ id: 'initial', seq: 1, at: 1_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([initial], { epoch: 2 }))
            .mockResolvedValueOnce(afterResponse([
                makeAgentMessage({ id: 'same', seq: 2, at: 1_500, invokedAt: null })
            ], {
                epoch: 2,
                nextAfterAt: 2_000,
                nextAfterSeq: 2,
                snapshotHeadAt: 2_000,
                snapshotHeadSeq: 2
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        ingestIncomingMessages(id, [makeAgentMessage({ id: 'same', seq: 2, at: 1_500, invokedAt: 2_000 })])
        await syncTailMessages(api, id)

        const matches = getMessageWindowState(id).messages.filter((message) => message.id === 'same')
        expect(matches).toHaveLength(1)
        expect(matches[0]?.invokedAt).toBe(2_000)
    })

    it('does not advance the tail cursor from an out-of-band consumed update', async () => {
        const id = sessionId('consumed-cursor-gap')
        const queued = makeUserMessage({
            id: 'queued',
            seq: 1,
            localId: 'local-1',
            createdAt: 1_000,
            invokedAt: null,
            status: 'queued'
        })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([queued], { epoch: 1 }))
            .mockResolvedValueOnce(afterResponse([
                makeAgentMessage({ id: 'missed', seq: 2, at: 2_000 })
            ], {
                epoch: 1,
                nextAfterAt: 3_000,
                nextAfterSeq: 1,
                snapshotHeadAt: 3_000,
                snapshotHeadSeq: 1
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        markMessagesConsumed(id, ['local-1'], 3_000)
        await syncTailMessages(api, id)

        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            afterAt: 1_000,
            afterSeq: 1,
            untilAt: null,
            untilSeq: null,
            epoch: 1,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'missed',
            'queued'
        ])
    })

    it('runs a guaranteed trailing request after an in-flight synchronization', async () => {
        const id = sessionId('trailing')
        const firstRequest = deferred<MessagesResponse>()
        const secondRequest = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await firstRequest.promise)
            .mockImplementationOnce(async () => await secondRequest.promise)
        const api = createApi(getMessages)

        const first = syncTailMessages(api, id)
        const trailing = syncTailMessages(api, id, { ensureAfterCurrent: true })
        expect(getMessages).toHaveBeenCalledTimes(1)

        firstRequest.resolve(latestResponse([
            makeAgentMessage({ id: 'first', seq: 1, at: 1_000 })
        ], { epoch: 1 }))
        await first
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))

        let trailingResolved = false
        void trailing.then(() => {
            trailingResolved = true
        })
        await Promise.resolve()
        expect(trailingResolved).toBe(false)

        secondRequest.resolve(afterResponse([], {
            epoch: 1,
            nextAfterAt: 1_000,
            nextAfterSeq: 1,
            snapshotHeadAt: 1_000,
            snapshotHeadSeq: 1
        }))
        await trailing
        expect(trailingResolved).toBe(true)
    })

    it('replaces stale server rows on epoch reset and preserves a not-yet-echoed optimistic send', async () => {
        const id = sessionId('epoch-reset')
        const old = makeAgentMessage({ id: 'old', seq: 1, at: 1_000 })
        const fresh = makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
        const optimistic = makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 1_500,
            invokedAt: null,
            status: 'sending'
        })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([old], { epoch: 1 }))
            .mockResolvedValueOnce(latestResponse([fresh], { epoch: 2, reset: true }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        appendOptimisticMessage(id, optimistic)

        await syncTailMessages(api, id)

        const state = getMessageWindowState(id)
        expect(state.messages.map((message) => message.id)).toEqual(['local-1', 'fresh'])
        expect(state.epoch).toBe(2)
    })

    it('preserves concurrent SSE and optimistic rows while applying an epoch reset', async () => {
        const id = sessionId('epoch-reset-sse-race')
        const old = makeAgentMessage({ id: 'old', seq: 1, at: 1_000 })
        const reset = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([old], { epoch: 1 }))
            .mockImplementationOnce(async () => await reset.promise)
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-reset',
            localId: 'local-reset',
            createdAt: 1_500,
            invokedAt: null,
            status: 'sending'
        }))

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 3, at: 3_000 })
        ])
        reset.resolve(latestResponse([
            makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
        ], { epoch: 2, reset: true }))
        await syncing

        const state = getMessageWindowState(id)
        expect(state.messages.map((message) => message.id)).toEqual([
            'local-reset',
            'fresh',
            'concurrent'
        ])
        expect(state.epoch).toBe(2)
        expect(state.newestSeq).toBe(3)
    })

    it('removes earlier HTTP pages when the epoch resets later in the same catch-up', async () => {
        const id = sessionId('mid-catch-up-reset')
        const reset = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'initial', seq: 1, at: 1_000 })
            ], { epoch: 1 }))
            .mockResolvedValueOnce(afterResponse([
                makeAgentMessage({ id: 'stale-page', seq: 2, at: 2_000 })
            ], {
                epoch: 1,
                nextAfterAt: 2_000,
                nextAfterSeq: 2,
                snapshotHeadAt: 3_000,
                snapshotHeadSeq: 3,
                hasMore: true
            }))
            .mockImplementationOnce(async () => await reset.promise)
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(3))
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'concurrent', seq: 11, at: 11_000 })
        ])
        reset.resolve(latestResponse([
            makeAgentMessage({ id: 'fresh', seq: 10, at: 10_000 })
        ], { epoch: 2, reset: true }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'fresh',
            'concurrent'
        ])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('invalidates an old request when the window is cleared and reloaded', async () => {
        const id = sessionId('clear-generation')
        const stale = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => await stale.promise)
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
            ], { epoch: 0 }))
        const api = createApi(getMessages)

        const oldSync = syncTailMessages(api, id)
        clearMessageWindow(id)
        await syncTailMessages(api, id)
        stale.reject(new Error('stale failure'))
        await oldSync

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).warning).toBeNull()
    })

    it('does not backfill older pages during the latest-tail request', async () => {
        const id = sessionId('no-cold-backfill')
        const traceRows = Array.from({ length: 200 }, (_, index) =>
            makeAgentRunMessage(`trace-${index}`, index + 101, index + 10_000)
        )
        const getMessages = vi.fn(async () => latestResponse(traceRows, {
            epoch: 0,
            hasMore: true,
            nextBeforeAt: 10_000,
            nextBeforeSeq: 101
        }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessageWindowState(id).hasMore).toBe(true)
    })
})

describe('history view and older pagination', () => {
    it('appends while reading history, then compacts at the tail', () => {
        const id = sessionId('history-unseen')
        const initial = Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) =>
            makeAgentMessage({ id: `initial-${index}`, seq: index + 1, at: index + 1 })
        )
        ingestIncomingMessages(id, initial)
        setMessageViewMode(id, 'history')

        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'new-1', seq: 401, at: 401 }),
            makeAgentMessage({ id: 'new-2', seq: 402, at: 402 })
        ])

        expect(getMessageWindowState(id).viewMode).toBe('history')
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('new-2')

        setMessageViewMode(id, 'tail')
        const state = getMessageWindowState(id)
        expect(state.viewMode).toBe('tail')
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.at(-1)?.id).toBe('new-2')
    })

    it('keeps rows dropped during tail compaction available to older pagination', async () => {
        const id = sessionId('tail-compaction-cursor')
        ingestIncomingMessages(id, Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) => {
            const seq = index + 1
            return makeAgentMessage({ id: `initial-${seq}`, seq, at: seq })
        }))
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'new-401', seq: 401, at: 401 }),
            makeAgentMessage({ id: 'new-402', seq: 402, at: 402 })
        ])

        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).hasMore).toBe(true)

        const getMessages = vi.fn(async () => beforeResponse([
            makeAgentMessage({ id: 'initial-1', seq: 1, at: 1 }),
            makeAgentMessage({ id: 'initial-2', seq: 2, at: 2 })
        ], {
            epoch: 0,
            hasMore: false,
            nextBeforeAt: 1,
            nextBeforeSeq: 1
        }))
        await fetchOlderMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, {
            beforeAt: 3,
            beforeSeq: 3,
            limit: 200
        })
        expect(getMessageWindowState(id).messages).toHaveLength(VISIBLE_WINDOW_SIZE + 2)
    })

    it('falls back to a latest request after the bounded history window overflows', async () => {
        const id = sessionId('history-overflow')
        const initial = makeAgentMessage({ id: 'initial', seq: 1, at: 1 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([initial], { epoch: 1 }))
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'latest', seq: 1_000, at: 1_000 })
            ], { epoch: 1 }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        setMessageViewMode(id, 'history')

        ingestIncomingMessages(id, Array.from({ length: HISTORY_WINDOW_SIZE + 10 }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        ))
        expect(getMessageWindowState(id).messages).toHaveLength(HISTORY_WINDOW_SIZE)

        setMessageViewMode(id, 'tail')
        await syncTailMessages(api, id)

        expect(getMessages.mock.calls[1]?.[1]).toEqual({ limit: 200 })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('latest')
    })

    it('loads exactly one raw older page with the paired composite cursor', async () => {
        const id = sessionId('older-page')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const older = makeAgentMessage({ id: 'older', seq: 9, at: 9_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        await fetchOlderMessages(api, id)

        expect(getMessages).toHaveBeenCalledTimes(2)
        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            beforeAt: 10_000,
            beforeSeq: 10,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['older', 'latest'])
    })

    it('advances the tail revision for live messages but not older-page loads', async () => {
        const id = sessionId('tail-revision')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const older = makeAgentMessage({ id: 'older', seq: 9, at: 9_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        const afterTailSync = getMessageWindowState(id).tailRevision
        setMessageViewMode(id, 'history')
        await fetchOlderMessages(api, id)

        expect(getMessageWindowState(id).tailRevision).toBe(afterTailSync)

        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'new-live', seq: 11, at: 11_000 })
        ])

        expect(getMessageWindowState(id).tailRevision).toBe(afterTailSync + 1)
    })

    it('leaves the window unchanged when the final older-page apply check rejects', async () => {
        const id = sessionId('older-page-apply-rejected')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const older = makeAgentMessage({ id: 'older', seq: 9, at: 9_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        const before = getMessageWindowState(id)

        const onBeforeApply = vi.fn(() => false)
        const outcome = await fetchOlderMessages(api, id, { onBeforeApply })

        expect(onBeforeApply).toHaveBeenCalledWith(before.historyVersion + 1)
        expect(outcome).toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(id)).toMatchObject({
            messages: [latest],
            isLoadingMore: false,
            historyVersion: before.historyVersion
        })
    })

    it('advances through hidden older rows without retaining them in the visible window', async () => {
        const id = sessionId('hidden-older-page')
        const latest = makeAgentMessage({ id: 'latest', seq: 10, at: 10_000 })
        const hidden = makeHiddenAgentMessage({ id: 'hidden', seq: 9, at: 9_000 })
        const older = makeAgentMessage({ id: 'older', seq: 8, at: 8_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([latest], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([hidden], {
                epoch: 4,
                hasMore: true,
                nextBeforeAt: 9_000,
                nextBeforeSeq: 9
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 4,
                hasMore: false,
                nextBeforeAt: 8_000,
                nextBeforeSeq: 8
            }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const hiddenOutcome = await fetchOlderMessages(api, id)
        expect(hiddenOutcome).toMatchObject({
            kind: 'applied',
            addedRenderableCount: 0
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])

        const visibleOutcome = await fetchOlderMessages(api, id)
        expect(visibleOutcome).toMatchObject({
            kind: 'applied',
            addedRenderableCount: 1
        })
        expect(getMessages.mock.calls[2]?.[1]).toMatchObject({
            beforeAt: 9_000,
            beforeSeq: 9
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['older', 'latest'])
    })

    it('discards an older response invalidated by a concurrent epoch reset', async () => {
        const id = sessionId('older-reset-race')
        const older = deferred<MessagesResponse>()
        const getMessages = vi.fn(async (_sessionId: string, options?: Parameters<ApiClient['getMessages']>[1]) => {
            if (options?.beforeAt !== undefined) {
                return await older.promise
            }
            if (options?.afterAt !== undefined) {
                return latestResponse([
                    makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
                ], { epoch: 2, reset: true })
            }
            return latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            })
        }) as ApiClient['getMessages']
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadingOlder = fetchOlderMessages(api, id)
        await vi.waitFor(() => expect(getMessageWindowState(id).isLoadingMore).toBe(true))
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id)).toMatchObject({
            epoch: 2,
            isLoadingMore: false
        })

        older.resolve(beforeResponse([
            makeAgentMessage({ id: 'stale-older', seq: 9, at: 9_000 })
        ], {
            epoch: 1,
            hasMore: false,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))
        expect(await loadingOlder).toEqual({ kind: 'stopped', reason: 'invalidated' })

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('treats an invalidated older request rejection as a stopped load', async () => {
        const id = sessionId('older-rejection-after-reset')
        const older = deferred<MessagesResponse>()
        const getMessages = vi.fn(async (_sessionId: string, options?: Parameters<ApiClient['getMessages']>[1]) => {
            if (options?.beforeAt !== undefined) {
                return await older.promise
            }
            if (options?.afterAt !== undefined) {
                return latestResponse([
                    makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
                ], { epoch: 2, reset: true })
            }
            return latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            })
        }) as ApiClient['getMessages']
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadingOlder = fetchOlderMessages(api, id)
        await vi.waitFor(() => expect(getMessageWindowState(id).isLoadingMore).toBe(true))
        await syncTailMessages(api, id)

        older.reject(new Error('stale transport failure'))

        expect(await loadingOlder).toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(id).warning).toBeNull()
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
    })

    it('rejects an older page that resolves after a reset request starts but before it applies', async () => {
        const id = sessionId('older-before-reset-response')
        const older = deferred<MessagesResponse>()
        const reset = deferred<MessagesResponse>()
        const getMessages = vi.fn(async (_sessionId: string, options?: Parameters<ApiClient['getMessages']>[1]) => {
            if (options?.beforeAt !== undefined) {
                return await older.promise
            }
            if (options?.afterAt !== undefined) {
                return await reset.promise
            }
            return latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            })
        }) as ApiClient['getMessages']
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadingOlder = fetchOlderMessages(api, id)
        await vi.waitFor(() => expect(getMessageWindowState(id).isLoadingMore).toBe(true))
        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(3))

        older.resolve(beforeResponse([
            makeAgentMessage({ id: 'stale-older', seq: 9, at: 9_000 })
        ], {
            epoch: 1,
            hasMore: false,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))
        expect(await loadingOlder).toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['initial'])

        reset.resolve(latestResponse([
            makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
        ], { epoch: 2, reset: true }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('ends the current coverage run when an older page discovers a new epoch', async () => {
        const id = sessionId('older-epoch-mismatch')
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'initial', seq: 10, at: 10_000 })
            ], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([], {
                epoch: 2,
                hasMore: false,
                nextBeforeAt: null,
                nextBeforeSeq: null
            }))
            .mockResolvedValueOnce(latestResponse([
                makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
            ], { epoch: 2 }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        const loadedOlderPage = await fetchOlderMessages(api, id)

        expect(loadedOlderPage).toEqual({ kind: 'stopped', reason: 'epoch-reset' })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).epoch).toBe(2)
    })

    it('protects regular conversation rows from an agent-run flood', () => {
        const id = sessionId('agent-run-budget')
        const root = makeUserMessage({ id: 'root', seq: 1, invokedAt: 1, createdAt: 1 })
        ingestIncomingMessages(id, [
            root,
            ...Array.from({ length: VISIBLE_WINDOW_SIZE + 1 }, (_, index) =>
                makeAgentRunMessage(`run-${index}`, index + 2, index + 2)
            )
        ])

        expect(getMessageWindowState(id).messages.some((message) => message.id === 'root')).toBe(true)
    })
})

describe('optimistic and queued-message operations', () => {
    it('replaces an optimistic row by localId and updates status in the canonical collection', () => {
        const id = sessionId('optimistic-replace')
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            invokedAt: null,
            status: 'sending'
        }))
        ingestIncomingMessages(id, [makeUserMessage({
            id: 'server-1',
            seq: 1,
            localId: 'local-1',
            invokedAt: null
        })])
        updateMessageStatus(id, 'local-1', 'sent')

        expect(getMessageWindowState(id).messages).toHaveLength(1)
        expect(getMessageWindowState(id).messages[0]).toMatchObject({
            id: 'server-1',
            status: 'sent'
        })
    })

    it('marks queued rows consumed and reorders them by invoked position', () => {
        const id = sessionId('consumed')
        ingestIncomingMessages(id, [
            makeUserMessage({
                id: 'queued',
                seq: 1,
                localId: 'local-1',
                createdAt: 1_000,
                invokedAt: null,
                status: 'queued'
            }),
            makeAgentMessage({ id: 'agent', seq: 2, at: 2_000 })
        ])

        const beforeConsumed = getMessageWindowState(id).tailRevision
        markMessagesConsumed(id, ['local-1'], 3_000)

        expect(getMessageWindowState(id).messages.at(-1)).toMatchObject({
            id: 'queued',
            status: 'sent',
            invokedAt: 3_000
        })
        expect(getMessageWindowState(id).tailRevision).toBe(beforeConsumed + 1)
    })

    it('reconciles queued candidates without a secondary pending collection', () => {
        const id = sessionId('queued-reconcile')
        ingestIncomingMessages(id, [
            makeUserMessage({ id: 'stale', seq: 1, localId: 'local-stale', invokedAt: null }),
            makeUserMessage({ id: 'queued', seq: 2, localId: 'local-queued', invokedAt: null }),
            makeUserMessage({
                id: 'local-optimistic',
                localId: 'local-optimistic',
                invokedAt: null,
                status: 'sending'
            })
        ])
        updateMessageStatus(id, 'local-optimistic', 'queued')

        expect(new Set(getQueuedReconcileCandidateLocalIds(id))).toEqual(new Set([
            'local-stale',
            'local-queued',
            'local-optimistic'
        ]))
        reconcileQueuedLocalIds(
            id,
            ['local-stale', 'local-queued', 'local-optimistic'],
            ['local-queued']
        )

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['queued'])
    })

    it('removes a queued or optimistic row by localId idempotently', () => {
        const id = sessionId('remove')
        appendOptimisticMessage(id, makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            invokedAt: null,
            status: 'queued'
        }))

        removeOptimisticMessage(id, 'local-1')
        removeOptimisticMessage(id, 'local-1')

        expect(getMessageWindowState(id).messages).toEqual([])
    })
})

describe('V2 persistence boundary', () => {
    it('ignores the V1 pending-buffer state entirely', () => {
        const id = sessionId('ignore-v1')
        sessionStorage.setItem(`hapi:message-window:v1:${id}`, JSON.stringify({
            messages: [makeAgentMessage({ id: 'legacy', seq: 1, at: 1 })],
            pending: []
        }))

        expect(getMessageWindowState(id).messages).toEqual([])
    })

    it('hydrates V2 sending rows as queued reconciliation candidates', () => {
        const id = sessionId('hydrate-sending')
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [makeUserMessage({
                id: 'local-1',
                localId: 'local-1',
                invokedAt: null,
                status: 'sending'
            })],
            hasMore: false,
            oldestPositionAt: null,
            oldestPositionSeq: null,
            newestPositionAt: null,
            newestPositionSeq: null,
            epoch: null
        }))

        expect(getMessageWindowState(id).messages[0]?.status).toBe('queued')
        expect(getQueuedReconcileCandidateLocalIds(id)).toEqual(['local-1'])
    })
})

describe('explicit history navigation', () => {
    it('keeps the newest rows instead of evicting them while navigating', () => {
        const id = sessionId('navigation-keeps-tail')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: HISTORY_WINDOW_SIZE + 50 }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        ))

        const state = getMessageWindowState(id)
        // The newest (live tail) rows survive the otherwise-bounded window.
        expect(state.messages).toHaveLength(HISTORY_WINDOW_SIZE + 50)
        expect(state.messages.at(-1)?.id).toBe(`overflow-${HISTORY_WINDOW_SIZE + 49}`)
        releaseNavigation()
    })

    it('evicts the newest rows again once the navigation ends', () => {
        const id = sessionId('navigation-overflow-after')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: HISTORY_WINDOW_SIZE + 50 }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        ))
        releaseNavigation()
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'one-more', seq: HISTORY_WINDOW_SIZE + 60, at: HISTORY_WINDOW_SIZE + 60 })
        ])

        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(HISTORY_WINDOW_SIZE)
        expect(state.messages.at(-1)?.id).toBe(`overflow-${HISTORY_WINDOW_SIZE - 1}`)
    })

    it('ignores tail-mode flips while navigating and resumes after', () => {
        const id = sessionId('navigation-pins-history')
        setMessageViewMode(id, 'history')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).viewMode).toBe('history')
        releaseNavigation()
        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).viewMode).toBe('tail')
    })

    it('pauses tail synchronization while navigating', async () => {
        const id = sessionId('navigation-pauses-tail-sync')
        const getMessages = vi.fn(async () => latestResponse([
            makeAgentMessage({ id: 'latest', seq: 1, at: 1 })
        ], { epoch: 1 }))
        const api = createApi(getMessages)
        const releaseNavigation = beginNavigation(id)
        await syncTailMessages(api, id)
        expect(getMessages).not.toHaveBeenCalled()
        releaseNavigation()
        await syncTailMessages(api, id)
        expect(getMessages).toHaveBeenCalledTimes(1)
    })

    it('runs a tail refresh requested during navigation once it ends', async () => {
        const id = sessionId('navigation-queued-tail-sync')
        const getMessages = vi.fn(async () => latestResponse([
            makeAgentMessage({ id: 'latest', seq: 1, at: 1 })
        ], { epoch: 1 }))
        const api = createApi(getMessages)
        const releaseNavigation = beginNavigation(id)
        await syncTailMessages(api, id, { ensureAfterCurrent: true })
        expect(getMessages).not.toHaveBeenCalled()
        // Ending the navigation starts the queued refresh without another call.
        releaseNavigation()
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1))
    })

    it('does not restart a queued tail refresh while a navigation lease is held', async () => {
        const id = sessionId('navigation-finish-race')
        // A slow tail sync starts before the navigation begins.
        let releaseFirstSync: (() => void) | null = null
        const firstSyncGate = new Promise<void>((resolve) => {
            releaseFirstSync = resolve
        })
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => {
                await firstSyncGate
                return latestResponse([
                    makeAgentMessage({ id: 'latest', seq: 1, at: 1 })
                ], { epoch: 1 })
            })
            .mockImplementation(async () => latestResponse([
                makeAgentMessage({ id: 'after-nav', seq: 2, at: 2 })
            ], { epoch: 1 }))
        const api = createApi(getMessages)
        const firstSync = syncTailMessages(api, id)
        // Navigation starts while the sync is still running; a refresh is
        // requested and queued.
        const releaseNavigation = beginNavigation(id)
        await syncTailMessages(api, id, { ensureAfterCurrent: true })
        expect(getMessages).toHaveBeenCalledTimes(1)
        // The in-flight sync completes: its finish must NOT restart the sync
        // while the lease is held.
        releaseFirstSync!()
        await firstSync
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1))
        // Releasing the lease runs the queued refresh exactly once.
        releaseNavigation()
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
    })

    it('does not apply an in-flight tail reset after navigation begins', async () => {
        const id = sessionId('navigation-cancels-running-tail')
        const original = [
            makeAgentMessage({ id: 'original-1', seq: 1, at: 1 }),
            makeAgentMessage({ id: 'original-2', seq: 2, at: 2 })
        ]
        ingestIncomingMessages(id, original)
        let releaseFirstSync: (() => void) | null = null
        const firstSyncGate = new Promise<void>((resolve) => {
            releaseFirstSync = resolve
        })
        const getMessages = vi.fn()
            .mockImplementationOnce(async () => {
                await firstSyncGate
                return latestResponse([
                    makeAgentMessage({ id: 'stale-reset', seq: 3, at: 3 })
                ], { epoch: 1 })
            })
            .mockImplementation(async () => latestResponse([
                ...original,
                makeAgentMessage({ id: 'post-navigation', seq: 4, at: 4 })
            ], { epoch: 1 }))
        const api = createApi(getMessages)
        const firstSync = syncTailMessages(api, id)
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')

        releaseFirstSync!()
        await firstSync

        expect(getMessageWindowState(id).messages.map((message) => message.id))
            .toEqual(original.map((message) => message.id))
        expect(getMessageWindowState(id).isSyncingTail).toBe(false)

        releaseNavigation()
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1))
        expect(getMessageWindowState(id).messages.map((message) => message.id))
            .toEqual(original.map((message) => message.id))

        setMessageViewMode(id, 'tail')
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        await syncTailMessages(api, id)
    })

    it('keeps both ends of the transcript with an explicit gap marker', () => {
        const id = sessionId('navigation-head-gap-tail')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 50
        ingestIncomingMessages(id, Array.from({ length: total }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        ))

        const state = getMessageWindowState(id)
        // Head + explicit gap marker + live tail: bounded, honest, and the
        // marker resets assistant→prompt association so the first retained
        // tail response cannot link to a head prompt.
        expect(state.messages).toHaveLength(HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 1)
        expect(state.messages[0]?.id).toBe('overflow-0')
        const gapIndex = state.messages.findIndex((message) => message.id.startsWith('__transcript-gap__'))
        expect(gapIndex).toBe(HISTORY_WINDOW_SIZE)
        expect(state.messages[gapIndex]?.content).toMatchObject({
            role: 'user'
        })
        // The marker carries a real timestamp so it is not treated as a
        // queued user message (those are filtered before normalization).
        expect(state.messages[gapIndex]?.invokedAt).not.toBeNull()
        expect(state.messages.at(-1)?.id).toBe(`overflow-${total - 1}`)
        releaseNavigation()
    })

    it('preserves queued rows dropped into the trimmed middle while navigating', () => {
        const id = sessionId('navigation-keeps-queued')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 50
        const messages = Array.from({ length: total }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        )
        ingestIncomingMessages(id, messages)
        // A queued user message whose natural position lands in the dropped
        // middle (between the retained head and tail).
        const queued = makeUserMessage({
            id: 'queued-middle',
            seq: HISTORY_WINDOW_SIZE + 100,
            localId: 'queued-middle',
            invokedAt: null
        })
        ingestIncomingMessages(id, [queued])

        const state = getMessageWindowState(id)
        expect(state.messages.some((message) => message.id === 'queued-middle')).toBe(true)
        releaseNavigation()
    })

    it('keeps every regular row when queued rows push the window past the cap', () => {
        const id = sessionId('navigation-queued-edge')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        // Exactly 1000 regular rows: at the head+tail cap.
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE
        const messages = Array.from({ length: total }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        )
        ingestIncomingMessages(id, messages)
        // One queued row pushes the combined window past the cap.
        const queued = makeUserMessage({
            id: 'queued-edge',
            seq: total + 1,
            localId: 'queued-edge',
            invokedAt: null
        })
        ingestIncomingMessages(id, [queued])

        const state = getMessageWindowState(id)
        // Every regular row survives (tail slice must use the trimmable
        // length, not the original array length) and no gap is introduced.
        expect(state.messages).toHaveLength(total + 1)
        expect(state.messages.some((message) => message.id.startsWith('__transcript-gap__'))).toBe(false)
        releaseNavigation()
    })

    it('keeps ordinary navigation rows outside the Codex agent-run budget', () => {
        const id = sessionId('navigation-agent-run-budget')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const ordinaryCount = 600
        const agentRunCount = 801
        const messages: DecryptedMessage[] = []
        let seq = 1
        for (let index = 0; index < agentRunCount; index += 1) {
            if (index < ordinaryCount) {
                messages.push(makeAgentMessage({
                    id: `ordinary-${index}`,
                    seq,
                    at: seq
                }))
                seq += 1
            }
            messages.push(makeAgentRunMessage(
                `run-${index}`,
                seq,
                seq,
                index % 3 === 0
                    ? 'agent-run-start'
                    : index % 3 === 1 ? 'agent-run-update' : 'agent-run-trace'
            ))
            seq += 1
        }

        ingestIncomingMessages(id, messages)

        const state = getMessageWindowState(id)
        expect(state.messages.filter((message) => message.id.startsWith('ordinary-'))).toHaveLength(ordinaryCount)
        expect(state.messages.filter((message) => message.id.startsWith('run-'))).toHaveLength(800)
        expect(state.messages.some((message) => message.id === 'run-0')).toBe(false)
        expect(state.messages.some((message) => message.id === 'run-800')).toBe(true)
        releaseNavigation()
    })

    it('keeps navigation active while any overlapping lease is held', () => {
        const id = sessionId('navigation-overlapping-leases')
        setMessageViewMode(id, 'history')
        const first = beginNavigation(id)
        const second = beginNavigation(id)
        // One lease released: the window must still be in navigation mode.
        first()
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(1)
        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).viewMode).toBe('history')
        // Releasing the last lease resumes normal behavior.
        second()
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(0)
        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).viewMode).toBe('tail')
        // Release is idempotent.
        second()
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(0)
    })
})

describe('reasoning snapshot compaction', () => {
    it('keeps only the newest snapshot of each stream', () => {
        const id = sessionId('reasoning-compaction')
        const snapshots = Array.from({ length: 5 }, (_, index) =>
            makeReasoningMessage(`snap-${index}`, 'stream-1', index + 1, index + 1)
        )
        const others = [
            makeUserMessage({ id: 'user-1', seq: 10, invokedAt: 10, createdAt: 10 }),
            makeUserMessage({ id: 'user-2', seq: 11, invokedAt: 11, createdAt: 11 })
        ]
        ingestIncomingMessages(id, [...snapshots, ...others])

        expect(getMessageWindowState(id).messages.map((message) => message.id))
            .toEqual(['snap-4', 'user-1', 'user-2'])
    })

    it('keeps the newest snapshot of every stream independently', () => {
        const id = sessionId('reasoning-multi-stream')
        ingestIncomingMessages(id, [
            makeReasoningMessage('a-1', 'stream-a', 1, 1),
            makeReasoningMessage('a-2', 'stream-a', 2, 2),
            makeReasoningMessage('b-1', 'stream-b', 3, 3),
            makeReasoningMessage('b-2', 'stream-b', 4, 4)
        ])

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['a-2', 'b-2'])
    })

    it('leaves messages without a reasoning stream untouched', () => {
        const id = sessionId('reasoning-unrelated')
        const messages = [
            makeUserMessage({ id: 'user-1', seq: 1, invokedAt: 1, createdAt: 1 }),
            makeAgentRunMessage('run-1', 2, 2),
            makeAgentRunMessage('run-2', 3, 3)
        ]
        ingestIncomingMessages(id, messages)

        expect(getMessageWindowState(id).messages).toHaveLength(3)
    })

    it('spends the window budget on conversation rather than duplicate snapshots', () => {
        const id = sessionId('reasoning-window-budget')
        // A session already carrying a flood of stored snapshots: without
        // compaction they consume the whole window and the conversation that
        // surrounds them falls out of it.
        const flood = Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) =>
            makeReasoningMessage(`flood-${index}`, 'stream-1', index + 1, index + 1)
        )
        const conversation = Array.from({ length: 50 }, (_, index) =>
            makeUserMessage({
                id: `talk-${index}`,
                seq: VISIBLE_WINDOW_SIZE + index + 1,
                invokedAt: VISIBLE_WINDOW_SIZE + index + 1,
                createdAt: VISIBLE_WINDOW_SIZE + index + 1
            })
        )
        ingestIncomingMessages(id, [...flood, ...conversation])

        const kept = getMessageWindowState(id).messages
        for (const message of conversation) {
            expect(kept.some((candidate) => candidate.id === message.id)).toBe(true)
        }
        expect(kept.filter((message) => message.id.startsWith('flood-'))).toHaveLength(1)
    })

    // The seq bounds are a view over what the window currently holds; the
    // cursor that drives older-page requests is the server's own
    // `nextBefore*`, which compaction never touches. Pinning the bounds keeps
    // that distinction honest if the two are ever conflated.
    it('derives its seq bounds from the surviving rows', () => {
        const id = sessionId('reasoning-bounds')
        ingestIncomingMessages(id, [
            makeReasoningMessage('snap-1', 'stream-1', 1, 1),
            makeReasoningMessage('snap-2', 'stream-1', 2, 2),
            makeUserMessage({ id: 'user-1', seq: 3, invokedAt: 3, createdAt: 3 })
        ])

        const state = getMessageWindowState(id)
        expect(state.oldestSeq).toBe(2)
        expect(state.newestSeq).toBe(3)
    })
})
