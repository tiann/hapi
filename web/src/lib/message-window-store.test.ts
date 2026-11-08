import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { aggregateResponseGroups } from '@/lib/assistant-runtime'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageContextResponse, MessagesResponse } from '@/types/api'
import {
    HISTORY_WINDOW_SIZE,
    INITIAL_PAGE_SIZE,
    VISIBLE_WINDOW_SIZE,
    activateMessageWindow,
    appendOptimisticMessage,
    clearMessageWindow,
    fetchOlderMessages,
    OLDER_LOAD_WINDOW_SIZE,
    getMessageWindowState,
    getQueuedReconcileCandidateLocalIds,
    ingestIncomingMessages,
    invalidateMessageWindow,
    fetchNewerMessages,
    loadMessageContext,
    markMessagesConsumed,
    reconcileQueuedLocalIds,
    removeOptimisticMessage,
    beginNavigation,
    rewindMessageWindow,
    setMessageWindowTargetLock,
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

function makeUsageMessage(props: { id: string; seq: number; at: number }): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'token_count', info: { total: { inputTokens: 4242, outputTokens: 7 } } }
            }
        },
        createdAt: props.at,
        invokedAt: props.at
    } as DecryptedMessage
}

function latestUsage(messages: DecryptedMessage[]) {
    const normalized = messages.flatMap(message => normalizeDecryptedMessage(message) ?? [])
    return reduceChatBlocks(normalized, null).latestUsage
}

function latestResponse(
    messages: DecryptedMessage[],
    options: {
        limit?: number
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
            limit: options.limit ?? 200,
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
    return { getMessages, getMessageContext: async () => null } as unknown as ApiClient
}

function contextResponse(
    messages: DecryptedMessage[],
    options: {
        epoch?: number
        hasMore?: boolean
        nextBeforeAt: number
        nextBeforeSeq: number
        snapshotHeadAt: number
        snapshotHeadSeq: number
        targetMessageId: string
    }
): MessageContextResponse {
    return {
        messages,
        targetMessageId: options.targetMessageId,
        page: {
            epoch: options.epoch ?? 0,
            hasMore: options.hasMore ?? false,
            nextBeforeAt: options.nextBeforeAt,
            nextBeforeSeq: options.nextBeforeSeq,
            snapshotHeadAt: options.snapshotHeadAt,
            snapshotHeadSeq: options.snapshotHeadSeq
        }
    }
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
        setMessageWindowTargetLock(id, false)
        clearMessageWindow(id)
    }
    touchedSessions.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
})

function makeToolMessages(count: number, firstSeq: number): DecryptedMessage[] {
    return Array.from({ length: count }, (_, index) => {
        const seq = firstSeq + index
        const callId = `call-${Math.floor(index / 2)}`
        return {
            id: `tool-${seq}`,
            seq,
            localId: null,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: index % 2 === 0
                        ? { type: 'tool-call', callId, name: 'Read', input: { file_path: `/f${index}` } }
                        : { type: 'tool-call-result', callId, output: 'ok' }
                }
            },
            createdAt: seq * 1_000,
            invokedAt: seq * 1_000
        } as DecryptedMessage
    })
}

describe('message tail synchronization', () => {

    it('lets a historical target cancel and block background tail synchronization', async () => {
        const id = sessionId('target-lock')
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await response.promise)
        const syncing = syncTailMessages(createApi(getMessages), id)

        setMessageWindowTargetLock(id, true)
        expect(getMessageWindowState(id).isSyncingTail).toBe(false)
        await syncTailMessages(createApi(vi.fn(async () => latestResponse([]))), id)
        expect(getMessages).toHaveBeenCalledTimes(1)

        response.resolve(latestResponse([
            makeAgentMessage({ id: 'stale-tail', seq: 1, at: 1_000 })
        ]))
        await syncing
        expect(getMessageWindowState(id).messages).toEqual([])

        setMessageWindowTargetLock(id, false)
    })

    it('does not reactivate a retained historical window into tail mode while locked', () => {
        const id = sessionId('target-lock-preserves-history')
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'historical', seq: 1, at: 1_000 })
        ])
        setMessageViewMode(id, 'history')
        setMessageWindowTargetLock(id, true)

        activateMessageWindow(id)

        expect(getMessageWindowState(id).viewMode).toBe('history')
        setMessageWindowTargetLock(id, false)
    })

it('fetches one older context page before first paint when the cold page is tool-only', async () => {
        const id = sessionId('cold-tool-only-context')
        const tools = makeToolMessages(INITIAL_PAGE_SIZE, 10)
        const context = makeAgentMessage({ id: 'context', seq: 9, at: 9_000 })
        const older = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse(tools, {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockReturnValueOnce(older.promise)

        const syncing = syncTailMessages(createApi(getMessages), id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        expect(getMessages.mock.calls[1]?.[1]).toEqual({ beforeAt: 10_000, beforeSeq: 10, limit: 200 })
        expect(getMessageWindowState(id)).toMatchObject({ isSyncingTail: true, messages: [] })

        older.resolve(beforeResponse([context], {
            epoch: 1,
            hasMore: true,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))
        await syncing

        const state = getMessageWindowState(id)
        expect(state.isSyncingTail).toBe(false)
        expect(state.hasMore).toBe(true)
        expect(state.messages.map((message) => message.id)).toEqual([
            'context',
            ...tools.map((message) => message.id)
        ])
    })

    it('releases a tool-only cold page when the context page exceeds the wait budget', async () => {
        vi.useFakeTimers()
        try {
            const id = sessionId('cold-tool-only-timeout')
            const tools = makeToolMessages(INITIAL_PAGE_SIZE, 10)
            const getMessages = vi.fn()
                .mockResolvedValueOnce(latestResponse(tools, {
                    epoch: 1,
                    hasMore: true,
                    nextBeforeAt: 10_000,
                    nextBeforeSeq: 10
                }))
                .mockReturnValueOnce(new Promise(() => {}))

            const syncing = syncTailMessages(createApi(getMessages), id)
            await vi.advanceTimersByTimeAsync(500)
            await syncing

            const state = getMessageWindowState(id)
            expect(state.isSyncingTail).toBe(false)
            expect(state.messages).toHaveLength(INITIAL_PAGE_SIZE)
        } finally {
            vi.useRealTimers()
        }
    })

    it('ignores queued prompts when classifying a tool-only cold page', async () => {
        const id = sessionId('cold-tool-only-queued')
        const tools = makeToolMessages(INITIAL_PAGE_SIZE, 10)
        const queued = makeUserMessage({ id: 'queued', localId: 'queued', createdAt: 99_000, invokedAt: null })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([...tools, queued], {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 10_000,
                nextBeforeSeq: 10
            }))
            .mockResolvedValueOnce(beforeResponse([], { epoch: 1, nextBeforeAt: null, nextBeforeSeq: null }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(2)
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toContain('queued')
    })

    it('does not fetch context on cached re-entry with a tool-only latest page', async () => {
        const id = sessionId('reentry-tool-only')
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [makeAgentMessage({ id: 'cached', seq: 5, at: 5_000 })],
            hasMore: true,
            oldestPositionAt: 5_000,
            oldestPositionSeq: 5,
            newestPositionAt: 5_000,
            newestPositionSeq: 5,
            epoch: 1
        }))
        activateMessageWindow(id)
        const getMessages = vi.fn().mockResolvedValueOnce(latestResponse(makeToolMessages(INITIAL_PAGE_SIZE, 10), {
            epoch: 1,
            hasMore: true,
            nextBeforeAt: 10_000,
            nextBeforeSeq: 10
        }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
    })

    it('does not fetch context when the cold page has conversation text', async () => {
        const id = sessionId('cold-text-no-context')
        const messages = [
            makeAgentMessage({ id: 'text', seq: 9, at: 9_000 }),
            ...makeToolMessages(INITIAL_PAGE_SIZE - 1, 10)
        ]
        const getMessages = vi.fn().mockResolvedValueOnce(latestResponse(messages, {
            epoch: 1,
            hasMore: true,
            nextBeforeAt: 9_000,
            nextBeforeSeq: 9
        }))

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessageWindowState(id).messages).toHaveLength(INITIAL_PAGE_SIZE)

    })

    it('uses a small cold latest page while keeping older loads at full page size', async () => {
        const id = sessionId('cold-initial-page')
        const latestMessages = Array.from({ length: INITIAL_PAGE_SIZE }, (_, index) =>
            makeAgentMessage({
                id: `latest-${index + 1}`,
                seq: index + 1,
                at: (index + 1) * 1_000
            })
        )
        const older = makeAgentMessage({ id: 'older', seq: 0, at: 0 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse(latestMessages, {
                epoch: 1,
                hasMore: true,
                nextBeforeAt: 1_000,
                nextBeforeSeq: 1
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 1,
                hasMore: false,
                nextBeforeAt: 0,
                nextBeforeSeq: 0
            }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
        expect(getMessageWindowState(id).messages).toHaveLength(INITIAL_PAGE_SIZE)

        await fetchOlderMessages(api, id)

        expect(getMessages).toHaveBeenLastCalledWith(id, {
            beforeAt: 1_000,
            beforeSeq: 1,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'older',
            ...latestMessages.map((message) => message.id)
        ])
    })

    it('removes the rewound suffix immediately and applies duplicate invalidations once', async () => {
        const id = sessionId('rewind-suffix')
        const prefix = makeAgentMessage({ id: 'prefix', seq: 1, at: 1_000 })
        const target = makeUserMessage({
            id: 'target',
            seq: 2,
            localId: 'target-local-id',
            createdAt: 2_000,
            invokedAt: 2_000
        })
        const suffix = makeAgentMessage({ id: 'suffix', seq: 3, at: 3_000 })
        const getMessages = vi.fn(async () => latestResponse([prefix, target, suffix], { epoch: 1 }))

        await syncTailMessages(createApi(getMessages), id)
        rewindMessageWindow(id, 'target-local-id')
        rewindMessageWindow(id, 'target-local-id')

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['prefix'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)
    })

    it('lets an authoritative rewind refresh through a historical target lock', async () => {
        const id = sessionId('rewind-target-lock')
        const prefix = makeAgentMessage({ id: 'prefix', seq: 1, at: 1_000 })
        const target = makeUserMessage({
            id: 'target',
            seq: 2,
            localId: 'rewind-target-lock-local-id',
            createdAt: 2_000,
            invokedAt: 2_000
        })
        const suffix = makeAgentMessage({ id: 'suffix', seq: 3, at: 3_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([prefix, target, suffix], { epoch: 1 }))
            .mockResolvedValueOnce(latestResponse([prefix], { epoch: 2 }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        setMessageWindowTargetLock(id, true)
        rewindMessageWindow(id, 'rewind-target-lock-local-id')
        await syncTailMessages(api, id)

        expect(getMessages).toHaveBeenCalledTimes(2)
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['prefix'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(false)
    })

    it('lets an epoch-change refresh through a historical target lock', async () => {
        const id = sessionId('epoch-target-lock')
        const current = makeAgentMessage({ id: 'current', seq: 10, at: 10_000 })
        const fresh = makeAgentMessage({ id: 'fresh', seq: 20, at: 20_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([current], {
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
            .mockResolvedValueOnce(latestResponse([fresh], { epoch: 2 }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        setMessageWindowTargetLock(id, true)
        await fetchOlderMessages(api, id)

        expect(getMessages).toHaveBeenCalledTimes(3)
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['fresh'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(false)
    })

    it('clears the window when the rewind boundary is outside the loaded page', async () => {
        const id = sessionId('rewind-boundary-not-loaded')
        const current = makeAgentMessage({ id: 'current', seq: 40, at: 40_000 })
        const getMessages = vi.fn(async () => latestResponse([current], { epoch: 1 }))

        await syncTailMessages(createApi(getMessages), id)
        rewindMessageWindow(id, 'boundary-not-loaded')

        expect(getMessageWindowState(id).messages).toEqual([])
    })

    it('deduplicates delayed rewind events across consecutive boundaries', async () => {
        const id = sessionId('rewind-delayed-event')
        const prefix = makeAgentMessage({ id: 'prefix', seq: 1, at: 1_000 })
        const firstBoundary = makeUserMessage({
            id: 'first-boundary',
            seq: 2,
            localId: 'first-boundary-local-id',
            createdAt: 2_000,
            invokedAt: 2_000
        })
        const secondBoundary = makeUserMessage({
            id: 'second-boundary',
            seq: 3,
            localId: 'second-boundary-local-id',
            createdAt: 3_000,
            invokedAt: 3_000
        })
        const suffix = makeAgentMessage({ id: 'suffix', seq: 4, at: 4_000 })
        const getMessages = vi.fn(async () => latestResponse(
            [prefix, firstBoundary, secondBoundary, suffix],
            { epoch: 1 }
        ))

        await syncTailMessages(createApi(getMessages), id)
        rewindMessageWindow(id, 'second-boundary-local-id')
        rewindMessageWindow(id, 'first-boundary-local-id')
        rewindMessageWindow(id, 'second-boundary-local-id')

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['prefix'])
    })

    it('retains the current window while a latest reset is in flight', async () => {
        const id = sessionId('invalidation-preserves-window')
        const current = makeAgentMessage({ id: 'current', seq: 10, at: 10_000 })
        const latest = makeAgentMessage({ id: 'latest', seq: 20, at: 20_000 })
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([current], { epoch: 1 }))
            .mockImplementationOnce(async () => await response.promise)
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        invalidateMessageWindow(id)

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['current'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
        expect(getMessages.mock.calls[1]?.[1]).toEqual({ limit: 200 })

        response.resolve(latestResponse([latest], { epoch: 2 }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(false)
    })

    it('renders a persisted window immediately, then requests a small latest tail on re-entry', async () => {
        const id = sessionId('reentry')
        const cached = makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [cached],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 40_000,
            newestPositionSeq: 40,
            epoch: 3,
            requiresLatestReset: false
        }))

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['cached'])
        setMessageViewMode(id, 'history')
        activateMessageWindow(id)
        expect(getMessageWindowState(id).viewMode).toBe('tail')

        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await response.promise)
        const syncing = syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['cached'])
        expect(getMessageWindowState(id).isSyncingTail).toBe(true)

        const latest = makeAgentMessage({ id: 'latest', seq: 2_040, at: 2_040_000 })
        response.resolve(latestResponse([latest], {
            limit: 20,
            epoch: 3,
            hasMore: true,
            nextBeforeAt: 1_841_000,
            nextBeforeSeq: 1_841
        }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual(['latest'])
        expect(getMessageWindowState(id).hasMore).toBe(true)
        expect('pending' in getMessageWindowState(id)).toBe(false)
    })

    it('retains Codex round duration through persisted re-entry and a user-free latest tail', async () => {
        const id = sessionId('codex-round-duration')
        const tail: DecryptedMessage[] = [
            { type: 'message', message: 'completed answer' },
            { type: 'token_count', flavor: 'codex', model: 'gpt-5.4',
                info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
            { type: 'turn_duration', flavor: 'codex', durationMs: 39_426 }
        ].map((data, index) => ({ id: `round-${index}`, seq: 40 + index, localId: null,
            createdAt: 40_000 + index, content: { role: 'agent', content: { type: 'codex', data: { ...data, turn_id: 'round' } } } }))
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: tail, hasMore: true, oldestPositionAt: 40_000, oldestPositionSeq: 40,
            newestPositionAt: 40_002, newestPositionSeq: 42, epoch: 3
        }))
        const assertDuration = () => {
            const messages = getMessageWindowState(id).messages
            expect(messages.map(message => message.id)).toEqual(['round-0', 'round-1', 'round-2'])
            const normalized = messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
            const { blocks } = reduceChatBlocks(normalized, null)
            const visible = buildVisibleChatBlocks(blocks, { hasMoreMessages: true })
            expect(aggregateResponseGroups(visible).get('round-0:0')?.roundSummary).toMatchObject({
                durationMs: 39_426, numTurns: 1, usage: { input_tokens: 100, output_tokens: 10 }
            })
        }
        assertDuration()
        activateMessageWindow(id)
        const getMessages = vi.fn(async () => latestResponse(JSON.parse(JSON.stringify(tail)) as DecryptedMessage[], {
            epoch: 3, limit: 20, hasMore: true, nextBeforeAt: 40_000, nextBeforeSeq: 40
        }))
        await syncTailMessages(createApi(getMessages), id)
        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
        assertDuration()
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

        expect(getMessages).toHaveBeenCalledWith(id, { limit: 20 })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'local-1',
            'latest'
        ])
        expect(getMessageWindowState(id).messages).toContainEqual(expect.objectContaining({
            id: 'local-1',
            status: 'queued'
        }))
    })

    it('keeps the latest page cursor available for older history after re-entry', async () => {
        const id = sessionId('reentry-older-history')
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

        activateMessageWindow(id)
        const latest = [
            makeAgentMessage({ id: 'latest-1', seq: 2_039, at: 2_039_000 }),
            makeAgentMessage({ id: 'latest-2', seq: 2_040, at: 2_040_000 })
        ]
        const older = makeAgentMessage({ id: 'older', seq: 2_038, at: 2_038_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse(latest, {
                limit: INITIAL_PAGE_SIZE,
                epoch: 3,
                hasMore: true,
                nextBeforeAt: 2_039_000,
                nextBeforeSeq: 2_039
            }))
            .mockResolvedValueOnce(beforeResponse([older], {
                epoch: 3,
                hasMore: false,
                nextBeforeAt: 2_038_000,
                nextBeforeSeq: 2_038
            }))
        const api = createApi(getMessages)

        await syncTailMessages(api, id)
        await fetchOlderMessages(api, id)

        expect(getMessages.mock.calls[0]?.[1]).toEqual({ limit: INITIAL_PAGE_SIZE })
        expect(getMessages.mock.calls[1]?.[1]).toEqual({
            beforeAt: 2_039_000,
            beforeSeq: 2_039,
            limit: 200
        })
        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'older',
            'latest-1',
            'latest-2'
        ])
    })

    it('keeps cached messages visible when the re-entry refresh fails', async () => {
        const id = sessionId('reentry-refresh-failure')
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

        activateMessageWindow(id)
        const getMessages = vi.fn(async () => {
            throw new Error('latest tail unavailable')
        })

        await syncTailMessages(createApi(getMessages), id)

        expect(getMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
        expect(getMessageWindowState(id)).toMatchObject({
            messages: [cached],
            isSyncingTail: false,
            warning: 'latest tail unavailable'
        })
    })

    it('preserves live and optimistic rows that arrive during a re-entry refresh', async () => {
        const id = sessionId('reentry-concurrent-rows')
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

        activateMessageWindow(id)
        const response = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await response.promise)
        const syncing = syncTailMessages(createApi(getMessages), id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE }))

        const optimistic = makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            createdAt: 41_000,
            invokedAt: null,
            status: 'sending'
        })
        appendOptimisticMessage(id, optimistic)
        const live = makeAgentMessage({ id: 'live', seq: 41, at: 41_000 })
        ingestIncomingMessages(id, [live])

        response.resolve(latestResponse([
            makeAgentMessage({ id: 'latest', seq: 2_040, at: 2_040_000 })
        ], { limit: INITIAL_PAGE_SIZE, epoch: 3 }))
        await syncing

        expect(getMessageWindowState(id).messages.map((message) => message.id)).toEqual([
            'live',
            'local-1',
            'latest'
        ])
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
            epoch: 3,
            requiresLatestReset: false
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
            epoch: 3,
            requiresLatestReset: false
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
        expect(getMessages.mock.calls[1]?.[1]).toEqual({ limit: 20 })
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

    it('drops live usage from a turn removed by an epoch reset', async () => {
        const id = sessionId('epoch-reset-live-usage')
        const old = makeAgentMessage({ id: 'old', seq: 1, at: 1_000 })
        const removedUsage = makeUsageMessage({ id: 'removed-usage', seq: 2, at: 3_000 })
        const fresh = makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([old], { epoch: 1 }))
            .mockResolvedValueOnce(latestResponse([fresh], { epoch: 2, reset: true }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        ingestIncomingMessages(id, [removedUsage])
        expect(getMessageWindowState(id).liveUsage).not.toBeNull()

        await syncTailMessages(api, id)

        expect(getMessageWindowState(id).liveUsage).toBeNull()
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

    it('releases a historical target lock when the window is cleared', async () => {
        const id = sessionId('clear-target-lock')
        const getMessages = vi.fn(async () => latestResponse([
            makeAgentMessage({ id: 'fresh-after-clear', seq: 1, at: 1_000 })
        ]))
        const api = createApi(getMessages)

        setMessageWindowTargetLock(id, true)
        clearMessageWindow(id)
        await syncTailMessages(api, id)

        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessageWindowState(id).messages.map((message) => message.id))
            .toEqual(['fresh-after-clear'])
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
        expect(getMessages).toHaveBeenCalledWith(id, { limit: INITIAL_PAGE_SIZE })
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

    it('keeps the Agent tool call whose sidechain rows survive the trim', async () => {
        const id = sessionId('subagent-parent')
        const claudeOutput = (msgId: string, seq: number, data: Record<string, unknown>) => ({
            id: msgId,
            seq,
            localId: null,
            content: { role: 'agent', content: { type: 'output', data } },
            createdAt: seq,
            invokedAt: seq
        } as DecryptedMessage)
        const parent = claudeOutput('agent-call', 1, {
            type: 'assistant',
            uuid: 'agent-call',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'work' } }] }
        })
        const sidechain = Array.from({ length: VISIBLE_WINDOW_SIZE + 5 }, (_, index) => claudeOutput(`side-${index}`, index + 2, {
            type: 'assistant',
            uuid: `side-${index}`,
            isSidechain: true,
            parentToolUseId: 'toolu_agent',
            message: { role: 'assistant', content: [{ type: 'text', text: `step ${index}` }] }
        }))
        ingestIncomingMessages(id, [parent, ...sidechain])

        const state = getMessageWindowState(id)
        expect(state.messages[0]?.id).toBe('agent-call')
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE + 1)

        // Paging older resumes at the window edge, not at the pinned parent.
        setMessageViewMode(id, 'history')
        const getMessages = vi.fn().mockResolvedValue(beforeResponse(
            [parent, ...sidechain.slice(0, 5)],
            { nextBeforeAt: null, nextBeforeSeq: null }
        ))
        await fetchOlderMessages(createApi(getMessages), id)
        expect(getMessages.mock.calls[0]?.[1]).toMatchObject({ beforeSeq: 7 })
        expect(getMessageWindowState(id).messages).toHaveLength(VISIBLE_WINDOW_SIZE + 6)

        // Compacting back to the tail and trimming again keeps both invariants.
        setMessageViewMode(id, 'tail')
        ingestIncomingMessages(id, [claudeOutput('side-next', VISIBLE_WINDOW_SIZE + 7, {
            type: 'assistant',
            uuid: 'side-next',
            isSidechain: true,
            parentToolUseId: 'toolu_agent',
            message: { role: 'assistant', content: [{ type: 'text', text: 'next step' }] }
        })])
        const compacted = getMessageWindowState(id)
        expect(compacted.messages[0]?.id).toBe('agent-call')
        expect(compacted.messages[1]?.seq).toBe(8)
        expect(compacted.messages).toHaveLength(VISIBLE_WINDOW_SIZE + 1)

        await fetchOlderMessages(createApi(getMessages), id)
        expect(getMessages.mock.calls[1]?.[1]).toMatchObject({ beforeSeq: 8 })
    })

    // Regression: clicking "Load earlier" on a RUNNING session used to be
    // pointless and destructive. The tail-mode trim evicted the freshly
    // loaded older pages on the very next streaming ingest (and one more row
    // per message afterwards), so the viewport anchored in the loaded range
    // jumped upward repeatedly. The loaded-history range must survive
    // streaming ingests while the user browses it.
    it('keeps loaded older pages in the window while a running session streams (tail mode)', async () => {
        const id = sessionId('running-tail-loaded-history')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        // Two "Load earlier" clicks from the tail: window 200 -> 600.
        const first = await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        expect(first.kind).toBe('applied')
        const second = await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        expect(second.kind).toBe('applied')
        expect(getMessageWindowState(id).messages[0]!.seq).toBe(1)
        expect(getMessageWindowState(id).messages).toHaveLength(600)

        // Running session: streaming messages arrive one by one.
        for (const seq of [601, 602, 603]) {
            ingestIncomingMessages(id, [makeAgentMessage({ id: `m-${seq}`, seq, at: seq })])
        }
        const state = getMessageWindowState(id)
        // The loaded range (m-1…) survives; the streaming tail stays visible.
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages).toHaveLength(603)
        expect(state.messages.at(-1)!.seq).toBe(603)

    })

    it('keeps loaded older pages and the streaming tail while reading history', async () => {
        const id = sessionId('running-history-loaded-history')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        setMessageViewMode(id, 'history')
        await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        const second = await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        expect(second.kind).toBe('applied')

        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-601', seq: 601, at: 601 })])
        const state = getMessageWindowState(id)
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages.at(-1)!.seq).toBe(601)

    })

    // Regression: while the history boundary is held, tail mode must not
    // trim — the loaded range and the live streaming tail both stay visible,
    // contiguous, and cursor-bookended. Trimming either side would make the
    // viewport jump (evicting the loaded range) or freeze the stream (a
    // dropped tail needs a tail resync that never fires on its own in tail
    // mode). Releasing the boundary compacts the window again.
    it('keeps the loaded range and the live tail contiguous while the boundary is held', async () => {
        const id = sessionId('loaded-history-no-gap')
        const all = Array.from({ length: 1_000 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[800]!.invokedAt ?? all[800]!.createdAt,
                nextBeforeSeq: 801
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        // Tail mode: load four older pages (the last crosses the old 800-row
        // cap) while the boundary is held (outline path).
        for (let page = 0; page < 4; page += 1) {
            const outcome = await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
            expect(outcome.kind).toBe('applied')
        }
        let state = getMessageWindowState(id)
        for (let index = 1; index < state.messages.length; index += 1) {
            expect(state.messages[index]!.seq).toBe(state.messages[index - 1]!.seq! + 1)
        }
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages.at(-1)!.seq).toBe(1_000)
        expect(state.oldestSeq).toBe(1)

        // Streaming past the cap: every new row stays visible (no frozen
        // tail), the loaded range stays intact, the window stays contiguous.
        for (let seq = 1_001; seq <= 1_300; seq += 1) {
            ingestIncomingMessages(id, [makeAgentMessage({ id: `m-${seq}`, seq, at: seq })])
        }
        state = getMessageWindowState(id)
        for (let index = 1; index < state.messages.length; index += 1) {
            expect(state.messages[index]!.seq).toBe(state.messages[index - 1]!.seq! + 1)
        }
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages.at(-1)!.seq).toBe(1_300)
        expect(state.oldestSeq).toBe(state.messages[0]!.seq)

        // Releasing the boundary (leaving history and returning to the tail)
        // compacts the window to the newest tail again.
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-1301', seq: 1301, at: 1301 })])
        state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(1_300)
        expect(state.messages.some(message => message.id === 'm-900')).toBe(true)
        expect(state.messages.at(-1)!.seq).toBe(1_300)
        setMessageViewMode(id, 'tail')
        state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(901)
        expect(state.messages.at(-1)!.seq).toBe(1_300)
    })

    // Regression: an older-page load made while the viewport is already at
    // the tail (outline "Load earlier") installs a history boundary with no
    // viewMode transition to release it. Re-asserting tail mode (the outline
    // closing at the bottom) must release the boundary and compact the
    // window back to the bounded tail.
    it('releases the loaded range when tail mode is re-asserted at the bottom', async () => {
        const id = sessionId('loaded-history-tail-reassert')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        // Outline "Load earlier" while already in tail mode: window 200 -> 400.
        const outcome = await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        expect(outcome.kind).toBe('applied')
        expect(getMessageWindowState(id).messages).toHaveLength(400)
        expect(getMessageWindowState(id).messages[0]!.seq).toBe(201)

        // Streaming keeps the window (boundary held, tail live).
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-601', seq: 601, at: 601 })])
        expect(getMessageWindowState(id).messages).toHaveLength(401)

        // Closing the outline re-asserts tail mode: the window compacts to
        // the newest tail and streaming trims resume normally.
        setMessageViewMode(id, 'tail')
        let state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(202)
        expect(state.messages.at(-1)!.seq).toBe(601)

        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-602', seq: 602, at: 602 })])
        state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(203)
        expect(state.messages.at(-1)!.seq).toBe(602)
    })

    // Regression: automatic loads outside the outline (e.g. the underfilled-
    // viewport coverage path) must not install the history boundary — there is
    // no outline-close or view-mode transition to release it, so the window
    // would stay unbounded for the rest of the session. Without the boundary
    // the base tail trim keeps the window bounded.
    it.each(['tail', 'history'] as const)('compacts reasoning snapshots with an outline boundary in %s mode', async (mode) => {
        const id = sessionId(`outline-reasoning-${mode}`)
        const all = Array.from({ length: 400 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const api = createApi(vi.fn()
            .mockResolvedValueOnce(latestResponse(all.slice(200), {
                epoch: 0, hasMore: true, nextBeforeAt: 201, nextBeforeSeq: 201
            }))
            .mockResolvedValueOnce(beforeResponse(all.slice(0, 200), {
                epoch: 0, hasMore: false, nextBeforeAt: 1, nextBeforeSeq: 1
            })))
        await syncTailMessages(api, id)
        await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        if (mode === 'history') setMessageViewMode(id, mode)
        for (let seq = 401; seq <= 801; seq += 1) {
            ingestIncomingMessages(id, [makeReasoningMessage(`reasoning-${seq}`, 'stream', seq, seq)])
        }
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'reply', seq: 802, at: 802 })])
        const messages = getMessageWindowState(id).messages
        expect(messages.filter(message => message.id.startsWith('reasoning-')).map(message => message.id)).toEqual(['reasoning-801'])
        expect(messages.some(message => message.id === 'reply')).toBe(true)
        expect(messages).toHaveLength(402)
    })

    it('keeps the agent-run budget separate while browsing protected history', async () => {
        const id = sessionId('outline-agent-run-budget')
        const all = Array.from({ length: 400 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const api = createApi(vi.fn()
            .mockResolvedValueOnce(latestResponse(all.slice(200), {
                epoch: 0, hasMore: true, nextBeforeAt: 201, nextBeforeSeq: 201
            }))
            .mockResolvedValueOnce(beforeResponse(all.slice(0, 200), {
                epoch: 0, hasMore: false, nextBeforeAt: 1, nextBeforeSeq: 1
            })))
        await syncTailMessages(api, id)
        await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        setMessageViewMode(id, 'history')
        for (let seq = 401; seq <= 1201; seq += 1) {
            ingestIncomingMessages(id, [makeAgentRunMessage(`run-${seq}`, seq, seq)])
        }
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'reply', seq: 1202, at: 1202 })])
        const messages = getMessageWindowState(id).messages
        expect(messages.filter(message => message.id.startsWith('run-'))).toHaveLength(800)
        expect(messages.filter(message => message.id.startsWith('m-'))).toHaveLength(400)
        expect(messages.some(message => message.id === 'reply')).toBe(true)
    })

    it('invalidates an outline load when its boundary is released at the tail cap', async () => {
        const id = sessionId('outline-release-at-cap')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const pending = deferred<MessagesResponse>()
        const api = createApi(vi.fn()
            .mockResolvedValueOnce(latestResponse(all.slice(200), {
                epoch: 0, hasMore: true, nextBeforeAt: 201, nextBeforeSeq: 201
            }))
            .mockReturnValueOnce(pending.promise))
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id).messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        let outlineOpen = true
        const loading = fetchOlderMessages(api, id, { shouldInstallBoundary: () => outlineOpen })
        outlineOpen = false
        setMessageViewMode(id, 'tail')
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-601', seq: 601, at: 601 })])
        outlineOpen = true
        pending.resolve(beforeResponse(all.slice(0, 200), {
            epoch: 0, hasMore: false, nextBeforeAt: 1, nextBeforeSeq: 1
        }))
        expect(await loading).toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(id).messages[0]?.seq).toBe(202)
        expect(getMessageWindowState(id).oldestSeq).toBe(202)
    })

    it('retains fetched pages beyond the older-load cap without an outline boundary', async () => {
        const id = sessionId('automatic-tail-load-prepend')
        const all = Array.from({ length: 1000 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const api = createApi(vi.fn(async (_sid: string, query: { beforeSeq?: number | null }) => {
            const older = all.filter(message => message.seq! < (query.beforeSeq ?? 1001))
            const page = older.slice(-200)
            const pagination = { epoch: 0, hasMore: older.length > page.length,
                nextBeforeAt: page[0]?.seq ?? null, nextBeforeSeq: page[0]?.seq ?? null }
            return query.beforeSeq == null ? latestResponse(page, pagination) : beforeResponse(page, pagination)
        }))
        await syncTailMessages(api, id)
        for (let page = 0; page < 4; page += 1) {
            expect((await fetchOlderMessages(api, id)).kind).toBe('applied')
        }
        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(800)
        expect(state.messages[0]?.seq).toBe(1)
        expect(state.messages.at(-1)?.seq).toBe(800)
        expect(state.oldestSeq).toBe(1)
    })

    it('keeps automatic tail-mode loads bounded (no boundary installed)', async () => {
        const id = sessionId('automatic-tail-load-bounded')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        // Coverage load at the tail: no installBoundary option.
        const outcome = await fetchOlderMessages(api, id)
        expect(outcome.kind).toBe('applied')
        expect(getMessageWindowState(id).messages).toHaveLength(400)

        // Streaming keeps the window at the tail cap (base trim resumes).
        for (let seq = 601; seq <= 620; seq += 1) {
            ingestIncomingMessages(id, [makeAgentMessage({ id: `m-${seq}`, seq, at: seq })])
        }
        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.at(-1)!.seq).toBe(620)
        expect(state.oldestSeq).toBe(state.messages[0]!.seq)
    })

    // Regression: the history boundary is persisted, but a boundary restored
    // from a previous page session must not survive — the outline that held
    // it is gone, so no release path exists and SSE ingests would grow the
    // window without limit. Activation clears it.
    it('drops a persisted history boundary on window activation', () => {
        const id = sessionId('persisted-boundary-release')
        const messages = Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages,
            hasMore: true,
            oldestPositionAt: 1,
            oldestPositionSeq: 1,
            newestPositionAt: 400,
            newestPositionSeq: 400,
            historyBoundaryAt: 201,
            historyBoundarySeq: 201,
            epoch: 0
        }))
        activateMessageWindow(id)

        // The boundary is released: the next streaming ingest trims back to
        // the tail cap instead of taking the no-trim branch.
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-401', seq: 401, at: 401 })])
        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(2)
        expect(state.messages.at(-1)!.seq).toBe(401)
    })

    // Regression: the boundary must be installed at REQUEST START, not when
    // the response applies. While an outline load is in flight, an SSE ingest
    // could evict the exclusive `before` cursor row (the window's oldest),
    // and applying the older page afterwards would leave a permanent
    // unreachable gap between the page and the trimmed window.
    it('protects the fetch cursor row while the outline request is in flight', async () => {
        const id = sessionId('outline-inflight-cursor-protected')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const pending = deferred<MessagesResponse>()
        let outlineRequestStarted = false
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                if (cursorSeq === 201 && !outlineRequestStarted) {
                    outlineRequestStarted = true
                    return await pending.promise
                }
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        // Automatic coverage load (no boundary): window 200 -> 400.
        const coverage = await fetchOlderMessages(api, id)
        expect(coverage.kind).toBe('applied')
        expect(getMessageWindowState(id).messages).toHaveLength(400)

        // Outline "Load earlier" starts; its GET stays pending.
        const loading = fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(outlineRequestStarted).toBe(true)

        // An SSE message lands while the request is in flight. Without the
        // request-start boundary, the tail trim would evict the `before` row
        // (m-201); with it, the window must stay whole.
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-601', seq: 601, at: 601 })])
        expect(getMessageWindowState(id).messages).toHaveLength(401)
        expect(getMessageWindowState(id).messages[0]!.seq).toBe(201)

        // The older page applies: no gap, cursor bookends the window.
        pending.resolve(beforeResponse(all.slice(0, 200), {
            epoch: 0,
            hasMore: false,
            nextBeforeAt: 1,
            nextBeforeSeq: 1
        }))
        const outcome = await loading
        expect(outcome.kind).toBe('applied')
        const state = getMessageWindowState(id)
        for (let index = 1; index < state.messages.length; index += 1) {
            expect(state.messages[index]!.seq).toBe(state.messages[index - 1]!.seq! + 1)
        }
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages.at(-1)!.seq).toBe(601)
        expect(state.oldestSeq).toBe(1)
    })

    // Regression: a provisional boundary installed for an in-flight outline
    // load must be removed when the load fails — otherwise the outline stays
    // open on a running session, every SSE message takes the no-trim branch,
    // and the window grows without limit.
    it('clears a provisional boundary when the outline load fails', async () => {
        const id = sessionId('outline-failed-boundary-clear')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const pending = deferred<MessagesResponse>()
        let outlinePending = false
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                if (!outlinePending) {
                    outlinePending = true
                    return await pending.promise
                }
                throw new Error('fixture: forced before-page failure')
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        // Outline load starts; while it is pending, SSE rows accumulate past
        // the tail cap because the provisional boundary holds the no-trim
        // branch.
        const loading = fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(outlinePending).toBe(true)
        for (let seq = 601; seq <= 850; seq += 1) {
            ingestIncomingMessages(id, [makeAgentMessage({ id: `m-${seq}`, seq, at: seq })])
        }
        expect(getMessageWindowState(id).messages).toHaveLength(450)

        // The load fails: the provisional boundary is released and the window
        // is compacted back to the tail cap immediately.
        pending.reject(new Error('fixture: forced before-page failure'))
        const outcome = await loading
        expect(outcome.kind).toBe('failed')
        let state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.at(-1)!.seq).toBe(850)
        expect(state.oldestSeq).toBe(state.messages[0]!.seq)

        // Further ingests keep trimming normally (no no-trim branch).
        for (let seq = 851; seq <= 900; seq += 1) {
            ingestIncomingMessages(id, [makeAgentMessage({ id: `m-${seq}`, seq, at: seq })])
        }
        state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.at(-1)!.seq).toBe(900)
        expect(state.oldestSeq).toBe(state.messages[0]!.seq)
    })

    // Regression: a tail resync invalidates an in-flight outline request via
    // the olderGeneration bump; the provisional boundary it installed must be
    // released with it, or the no-trim branch outlives the load.
    it('releases a provisional boundary when a tail resync invalidates the outline request', async () => {
        const id = sessionId('outline-resync-releases-boundary')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const pending = deferred<MessagesResponse>()
        let outlinePending = false
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                if (!outlinePending) {
                    outlinePending = true
                    return await pending.promise
                }
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        // Outline load starts; its GET stays pending with the boundary
        // provisionally installed (ingest takes the no-trim branch).
        const loading = fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(outlinePending).toBe(true)
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-601', seq: 601, at: 601 })])
        expect(getMessageWindowState(id).messages).toHaveLength(201)

        // A tail resync invalidates the in-flight request and must release
        // the provisional boundary.
        await syncTailMessages(api, id)
        pending.resolve(beforeResponse(all.slice(0, 200), {
            epoch: 0,
            hasMore: false,
            nextBeforeAt: 1,
            nextBeforeSeq: 1
        }))
        const outcome = await loading
        expect(outcome.kind).toBe('stopped')

        // The boundary is gone: ingests trim back to the tail cap.
        for (let seq = 602; seq <= 850; seq += 1) {
            ingestIncomingMessages(id, [makeAgentMessage({ id: `m-${seq}`, seq, at: seq })])
        }
        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.at(-1)!.seq).toBe(850)
        expect(state.oldestSeq).toBe(state.messages[0]!.seq)
    })

    // Regression: re-asserting tail mode (outline closed / back at the bottom)
    // compacts the window while an outline request is still in flight; the
    // compaction can evict the request's `before` cursor row, so the request
    // must be invalidated instead of applying against a stale cursor.
    it('invalidates an in-flight outline request when the tail compacts it', async () => {
        const id = sessionId('outline-compact-invalidates-inflight')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const pending = deferred<MessagesResponse>()
        let outlinePending = false
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                if (!outlinePending) {
                    outlinePending = true
                    return await pending.promise
                }
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)

        // Outline load starts (pending) and the provisional boundary lets SSE
        // rows accumulate past the tail cap.
        const loading = fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(outlinePending).toBe(true)
        for (let seq = 601; seq <= 850; seq += 1) {
            ingestIncomingMessages(id, [makeAgentMessage({ id: `m-${seq}`, seq, at: seq })])
        }
        expect(getMessageWindowState(id).messages).toHaveLength(450)

        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).messages).toHaveLength(450)
        expect(getMessageWindowState(id).isLoadingMore).toBe(true)
        releaseNavigation()

        // Returning to the tail compacts the window and must invalidate the
        // in-flight request (its `before` cursor row was shed).
        setMessageViewMode(id, 'tail')
        const compacted = getMessageWindowState(id)
        expect(compacted.viewMode).toBe('tail')
        expect(compacted.navigationLeaseCount).toBe(0)
        expect(compacted.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(compacted.messages.at(-1)!.seq).toBe(850)

        pending.resolve(beforeResponse(all.slice(0, 200), {
            epoch: 0,
            hasMore: false,
            nextBeforeAt: 1,
            nextBeforeSeq: 1
        }))
        const outcome = await loading
        expect(outcome.kind).toBe('stopped')

        // The window stays bounded and the cursor keeps bookending it.
        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.oldestSeq).toBe(state.messages[0]!.seq)
        expect(state.messages.at(-1)!.seq).toBe(850)
    })

    it('preserves history rows when a provisional load fails', async () => {
        const id = sessionId('history-provisional-failure')
        const initial = Array.from({ length: 200 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse(initial, {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: 1,
                nextBeforeSeq: 1
            }))
            .mockRejectedValueOnce(new Error('fixture: before-page failure'))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: 400 }, (_, index) => {
            const seq = index + 201
            return makeAgentMessage({ id: `m-${seq}`, seq, at: seq })
        }))

        const outcome = await fetchOlderMessages(api, id, {
            shouldInstallBoundary: () => true
        })

        expect(outcome.kind).toBe('failed')
        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(HISTORY_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages.at(-1)!.seq).toBe(600)
    })

    it('preserves history rows when a provisional load is invalidated', async () => {
        const id = sessionId('history-provisional-invalidation')
        const initial = Array.from({ length: 200 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const older = deferred<MessagesResponse>()
        const tail = deferred<MessagesResponse>()
        const getMessages = vi.fn(async (
            _sessionId: string,
            options?: Parameters<ApiClient['getMessages']>[1]
        ) => {
            if (options?.beforeAt !== undefined) return await older.promise
            if (options?.afterAt !== undefined) return await tail.promise
            return latestResponse(initial, {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: 1,
                nextBeforeSeq: 1
            })
        }) as ApiClient['getMessages']
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: 400 }, (_, index) => {
            const seq = index + 201
            return makeAgentMessage({ id: `m-${seq}`, seq, at: seq })
        }))

        const loading = fetchOlderMessages(api, id, {
            shouldInstallBoundary: () => true
        })
        await vi.waitFor(() => expect(getMessageWindowState(id).isLoadingMore).toBe(true))
        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(3))

        let state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(HISTORY_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages.at(-1)!.seq).toBe(600)

        tail.resolve(afterResponse([], {
            epoch: 0,
            nextAfterAt: 600,
            nextAfterSeq: 600,
            snapshotHeadAt: 600,
            snapshotHeadSeq: 600
        }))
        await syncing
        older.resolve(beforeResponse([], {
            epoch: 0,
            hasMore: false,
            nextBeforeAt: null,
            nextBeforeSeq: null
        }))
        expect(await loading).toEqual({ kind: 'stopped', reason: 'invalidated' })

        state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(HISTORY_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(1)
        expect(state.messages.at(-1)!.seq).toBe(600)
    })

    it('releases the loaded range when the user returns to the tail', async () => {
        const id = sessionId('loaded-history-tail-release')
        const all = Array.from({ length: 600 }, (_, index) =>
            makeAgentMessage({ id: `m-${index + 1}`, seq: index + 1, at: index + 1 })
        )
        const getMessages = vi.fn(async (_sid: string, query: {
            limit?: number
            beforeAt?: number | null
            beforeSeq?: number | null
        }) => {
            if (query.beforeSeq != null || query.beforeAt != null) {
                const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
                const older = all.filter((message) => message.seq! < cursorSeq)
                const page = older.slice(-200)
                return beforeResponse(page, {
                    epoch: 0,
                    hasMore: older.length > page.length,
                    nextBeforeAt: page[0]?.invokedAt ?? page[0]?.createdAt ?? null,
                    nextBeforeSeq: page[0]?.seq ?? null
                })
            }
            return latestResponse(all.slice(-200), {
                epoch: 0,
                hasMore: true,
                nextBeforeAt: all[400]!.invokedAt ?? all[400]!.createdAt,
                nextBeforeSeq: 401
            })
        })
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        setMessageViewMode(id, 'history')
        await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })
        await fetchOlderMessages(api, id, { shouldInstallBoundary: () => true })

        // Back to the bottom: the window compacts to the newest tail and the
        // protection is released, so streaming trims resume normally.
        setMessageViewMode(id, 'tail')
        let state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(201)

        ingestIncomingMessages(id, [makeAgentMessage({ id: 'm-601', seq: 601, at: 601 })])
        state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages[0]!.seq).toBe(202)
        expect(state.messages.at(-1)!.seq).toBe(601)
    })
})

describe('reading forward from a context window', () => {
    it('reports more newer messages when the context stops short of the head', async () => {
        const id = sessionId('context-forward-flag')
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const api = createApi(vi.fn(async () => latestResponse([])))
        api.getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))

        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // The head is recorded for tail sync, but the window itself ends at 40.
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)
    })

    it('does not offer forward loading when the context already reaches the head', async () => {
        const id = sessionId('context-forward-at-head')
        const target = makeAgentMessage({ id: 'target', seq: 100, at: 100_000 })
        const api = createApi(vi.fn(async () => latestResponse([])))
        api.getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 100_000,
            nextBeforeSeq: 100,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))

        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)
        expect(getMessageWindowState(id).hasMoreNewer).toBe(false)
    })

    it('loads a bounded newer page and keeps going until the head is reached', async () => {
        const id = sessionId('context-forward-paging')
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const getMessages = vi.fn()
        const api = createApi(getMessages)
        api.getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // First forward page stops mid-gap: still short of seq 100.
        getMessages.mockResolvedValueOnce(afterResponse([
            makeAgentMessage({ id: 'mid', seq: 60, at: 60_000 })
        ], {
            epoch: 7,
            hasMore: true,
            nextAfterAt: 60_000,
            nextAfterSeq: 60,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100
        }))
        const first = await fetchNewerMessages(api, id)

        expect(getMessages.mock.calls[0]?.[1]).toMatchObject({ afterAt: 40_000, afterSeq: 40 })
        expect(first.kind).toBe('loaded')
        expect(getMessageWindowState(id).messages.map((m) => m.id)).toEqual(['target', 'mid'])
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)

        // Second page reaches the head: forward loading is done.
        getMessages.mockResolvedValueOnce(afterResponse([
            makeAgentMessage({ id: 'head', seq: 100, at: 100_000 })
        ], {
            epoch: 7,
            hasMore: false,
            nextAfterAt: 100_000,
            nextAfterSeq: 100,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100
        }))
        const second = await fetchNewerMessages(api, id)

        expect(getMessages.mock.calls[1]?.[1]).toMatchObject({ afterAt: 60_000, afterSeq: 60 })
        expect(second.kind).toBe('caught-up')
        expect(getMessageWindowState(id).hasMoreNewer).toBe(false)
        expect(getMessageWindowState(id).messages.map((m) => m.id)).toEqual(['target', 'mid', 'head'])
    })

    it('ignores a concurrently streamed head row when advancing the cursor', async () => {
        const id = sessionId('context-forward-sse-race')
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const getMessages = vi.fn()
        const api = createApi(getMessages)
        api.getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // A live row lands at the head while the reader is still mid-history.
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'live', seq: 1_001, at: 1_001_000 })
        ])

        getMessages.mockResolvedValueOnce(afterResponse([
            makeAgentMessage({ id: 'mid', seq: 60, at: 60_000 })
        ], {
            epoch: 7,
            hasMore: true,
            nextAfterAt: 60_000,
            nextAfterSeq: 60,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100
        }))
        const outcome = await fetchNewerMessages(api, id)

        // The cursor follows the page boundary, not the streamed row, so the
        // gap between 60 and the head is still reachable.
        expect(outcome.kind).toBe('loaded')
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)
        getMessages.mockResolvedValueOnce(afterResponse([], {
            epoch: 7,
            hasMore: true,
            nextAfterAt: 80_000,
            nextAfterSeq: 80,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100
        }))
        await fetchNewerMessages(api, id)
        expect(getMessages.mock.calls[1]?.[1]).toMatchObject({ afterAt: 60_000, afterSeq: 60 })
    })

    it('keeps forward loading available when the context carries a queued prompt', async () => {
        const id = sessionId('context-forward-queued')
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        // The hub appends pending prompts to context responses out-of-band;
        // they carry a real seq at the session head and must not be mistaken
        // for the bounded window's own pagination boundary.
        const queued = makeUserMessage({
            id: 'queued-server',
            localId: 'queued-server',
            seq: 1_001,
            createdAt: 1_001_000,
            invokedAt: null,
            status: 'queued'
        })
        const api = createApi(vi.fn(async () => latestResponse([])))
        api.getMessageContext = vi.fn(async () => contextResponse([target, queued], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))

        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // Without excluding the queued row the cursor would jump to 1001 and
        // report caught-up, stranding messages 41-100.
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)
    })

    it('clamps the forward cursor when older loading evicts newer rows', async () => {
        const id = sessionId('context-forward-evicted')
        const target = makeAgentMessage({ id: 'target', seq: 1_000, at: 1_000_000 })
        const getMessages = vi.fn()
        const api = createApi(getMessages)
        api.getMessageContext = vi.fn(async () => contextResponse([
            target,
            makeAgentMessage({ id: 'ctx-newest', seq: 1_020, at: 1_020_000 })
        ], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 1_000_000,
            nextBeforeSeq: 1_000,
            snapshotHeadAt: 2_000_000,
            snapshotHeadSeq: 2_000,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)

        // An older page large enough to push the context rows out of the window.
        const older = Array.from({ length: OLDER_LOAD_WINDOW_SIZE }, (_, index) => (
            makeAgentMessage({
                id: `older-${index}`,
                seq: index + 1,
                at: (index + 1) * 1_000
            })
        ))
        getMessages.mockResolvedValueOnce(beforeResponse(older, {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 1_000,
            nextBeforeSeq: 1
        }))
        await fetchOlderMessages(api, id)

        const state = getMessageWindowState(id)
        expect(state.messages.some((message) => message.id === 'ctx-newest')).toBe(false)
        expect(state.hasMoreNewer).toBe(true)

        // Forward loading must resume from what is retained, not from 1020.
        getMessages.mockResolvedValueOnce(afterResponse([], {
            epoch: 7,
            hasMore: true,
            nextAfterAt: 1_500_000,
            nextAfterSeq: 1_500,
            snapshotHeadAt: 2_000_000,
            snapshotHeadSeq: 2_000
        }))
        await fetchNewerMessages(api, id)
        const forwardCall = getMessages.mock.calls.at(-1)?.[1] as { afterSeq?: number }
        expect(forwardCall?.afterSeq).toBeLessThan(1_020)
    })

    it('keeps the session head when live updates trim the history window', async () => {
        const id = sessionId('context-forward-sse-trim')
        const target = makeAgentMessage({ id: 'target', seq: 800, at: 800_000 })
        const getMessages = vi.fn()
        const api = createApi(getMessages)
        api.getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 800_000,
            nextBeforeSeq: 800,
            snapshotHeadAt: 2_000_000,
            snapshotHeadSeq: 2_000,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // Enough live rows to overflow the window and force a prepend trim,
        // which used to replace the session head with the retained boundary.
        ingestIncomingMessages(id, Array.from({ length: 620 }, (_, index) => (
            makeAgentMessage({
                id: `live-${index}`,
                seq: 900 + index,
                at: (900 + index) * 1_000
            })
        )))

        // The real head is 2000, so a page that reports more remaining must
        // not be treated as caught up.
        // The trim leaves a retained boundary near seq 1498. A forward page
        // landing past that but short of the real head at 2000 is exactly
        // where a clobbered head would wrongly report caught-up.
        getMessages.mockResolvedValueOnce(afterResponse([], {
            epoch: 7,
            hasMore: true,
            nextAfterAt: 1_600_000,
            nextAfterSeq: 1_600,
            snapshotHeadAt: 2_000_000,
            snapshotHeadSeq: 2_000
        }))
        const outcome = await fetchNewerMessages(api, id)

        expect(outcome.kind).toBe('loaded')
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)
    })

    it('follows the head the response reports when the session grew', async () => {
        const id = sessionId('context-forward-grown-head')
        const target = makeAgentMessage({ id: 'target', seq: 1_800, at: 1_800_000 })
        const getMessages = vi.fn()
        const api = createApi(getMessages)
        api.getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 1_800_000,
            nextBeforeSeq: 1_800,
            snapshotHeadAt: 2_000_000,
            snapshotHeadSeq: 2_000,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // The session grew past the head recorded at context load, and the
        // page says so. Reaching the old head must not end forward reading.
        getMessages.mockResolvedValueOnce(afterResponse([], {
            epoch: 7,
            hasMore: true,
            nextAfterAt: 2_000_000,
            nextAfterSeq: 2_000,
            snapshotHeadAt: 2_001_000,
            snapshotHeadSeq: 2_001
        }))
        const outcome = await fetchNewerMessages(api, id)

        expect(outcome.kind).toBe('loaded')
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)
    })

    it('keeps the anchored row when a forward page would trim it away', async () => {
        const id = sessionId('context-forward-anchor-kept')
        const target = makeAgentMessage({ id: 'target', seq: 1, at: 1_000 })
        const getMessages = vi.fn()
        const api = createApi(getMessages)
        api.getMessageContext = vi.fn(async () => contextResponse([
            target,
            ...Array.from({ length: 599 }, (_, index) => makeAgentMessage({
                id: `ctx-${index}`,
                seq: index + 2,
                at: (index + 2) * 1_000
            }))
        ], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 1_000,
            nextBeforeSeq: 1,
            snapshotHeadAt: 9_000_000,
            snapshotHeadSeq: 9_000,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // A full page arrives while the reader sits on the oldest row.
        getMessages.mockResolvedValueOnce(afterResponse(
            Array.from({ length: 200 }, (_, index) => makeAgentMessage({
                id: `fwd-${index}`,
                seq: 1_000 + index,
                at: (1_000 + index) * 1_000
            })),
            {
                epoch: 7,
                hasMore: true,
                nextAfterAt: 1_199_000,
                nextAfterSeq: 1_199,
                snapshotHeadAt: 9_000_000,
                snapshotHeadSeq: 9_000
            }
        ))
        await fetchNewerMessages(api, id, { resolvePreserveMessageId: () => 'target' })

        // Without the guard the oldest rows are trimmed and the reader is
        // dropped somewhere else entirely.
        expect(getMessageWindowState(id).messages.some((m) => m.id === 'target')).toBe(true)
    })

    it('protects the row the reader moved to, not the one they started from', async () => {
        const id = sessionId('context-forward-anchor-moves')
        const target = makeAgentMessage({ id: 'target', seq: 1, at: 1_000 })
        const getMessages = vi.fn()
        const api = createApi(getMessages)
        api.getMessageContext = vi.fn(async () => contextResponse([
            target,
            ...Array.from({ length: 599 }, (_, i) => makeAgentMessage({
                id: `ctx-${i}`, seq: i + 2, at: (i + 2) * 1_000
            }))
        ], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 1_000,
            nextBeforeSeq: 1,
            snapshotHeadAt: 9_000_000,
            snapshotHeadSeq: 9_000,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        // The reader starts at the bottom, then scrolls back to the oldest row
        // while the page is still in flight.
        let anchored = 'ctx-598'
        getMessages.mockImplementationOnce(async () => {
            anchored = 'target'
            return afterResponse(
                Array.from({ length: 200 }, (_, i) => makeAgentMessage({
                    id: `fwd-${i}`, seq: 1_000 + i, at: (1_000 + i) * 1_000
                })),
                {
                    epoch: 7,
                    hasMore: true,
                    nextAfterAt: 1_199_000,
                    nextAfterSeq: 1_199,
                    snapshotHeadAt: 9_000_000,
                    snapshotHeadSeq: 9_000
                }
            )
        })
        await fetchNewerMessages(api, id, { resolvePreserveMessageId: () => anchored })

        // A value captured at request time would have protected 'ctx-598' and
        // trimmed 'target' out from under the reader.
        expect(getMessageWindowState(id).messages.some((m) => m.id === 'target')).toBe(true)
    })

    it('drops the forward cursor when the window returns to the tail', async () => {
        const id = sessionId('context-forward-tail-return')
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const api = createApi(vi.fn(async () => latestResponse([])))
        api.getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))
        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)

        setMessageViewMode(id, 'tail')

        // Otherwise a later hit already inside the latest window would page
        // from the stale historical cursor and splice in disconnected rows.
        expect(getMessageWindowState(id).hasMoreNewer).toBe(false)
        expect(await fetchNewerMessages(api, id))
            .toEqual({ kind: 'stopped', reason: 'exhausted' })
    })

    it('seeds the forward cursor when older paging trims a search-locked window', async () => {
        const id = sessionId('context-forward-already-loaded')
        // A hit already inside the rendered window: loadMessageContext is
        // skipped, so there is no cursor, but the search lock is held.
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: Array.from({ length: 700 }, (_, i) => makeAgentMessage({
                id: `row-${i}`, seq: i + 100, at: (i + 100) * 1_000
            })),
            hasMore: true,
            oldestPositionAt: 100_000,
            oldestPositionSeq: 100,
            newestPositionAt: 799_000,
            newestPositionSeq: 799,
            epoch: 7,
            requiresLatestReset: false
        }))
        setMessageViewMode(id, 'history')
        setMessageWindowTargetLock(id, true)
        expect(getMessageWindowState(id).hasMoreNewer).toBe(false)

        // Older paging prepends enough rows to push the newer end out.
        const getMessages = vi.fn().mockResolvedValueOnce(beforeResponse(
            Array.from({ length: 400 }, (_, i) => makeAgentMessage({
                id: `older-${i}`, seq: i + 1, at: (i + 1) * 100
            })),
            { epoch: 7, hasMore: true, nextBeforeAt: 100, nextBeforeSeq: 1 }
        ))
        await fetchOlderMessages(createApi(getMessages), id)

        // The trimmed-away newer rows must stay reachable by reading forward.
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)
        setMessageWindowTargetLock(id, false)
    })

    it('refuses to page forward when there is nothing ahead', async () => {
        const id = sessionId('context-forward-exhausted')
        const getMessages = vi.fn()
        const api = createApi(getMessages)

        const outcome = await fetchNewerMessages(api, id)

        expect(outcome).toEqual({ kind: 'stopped', reason: 'exhausted' })
        expect(getMessages).not.toHaveBeenCalled()
    })

    it('restores the forward cursor from a persisted context window', () => {
        const id = sessionId('context-forward-persist')
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })],
            hasMore: false,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 100_000,
            newestPositionSeq: 100,
            contextNewestAt: 40_000,
            contextNewestSeq: 40,
            epoch: 7,
            requiresLatestReset: true
        }))

        // Reading forward survives the reload instead of dead-ending again.
        expect(getMessageWindowState(id).hasMoreNewer).toBe(true)
    })

    it('does not resume forward loading for a legacy window with no context cursor', () => {
        const id = sessionId('context-forward-legacy')
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [makeAgentMessage({ id: 'cached', seq: 40, at: 40_000 })],
            hasMore: false,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
            newestPositionAt: 100_000,
            newestPositionSeq: 100,
            epoch: 7,
            requiresLatestReset: true
        }))

        expect(getMessageWindowState(id).hasMoreNewer).toBe(false)
    })
})

describe('search-target message context', () => {
    it('lets an initial tail sync register before requesting search context', async () => {
        const id = sessionId('search-context-initial-tail-race')
        const latest = makeAgentMessage({ id: 'latest', seq: 100, at: 100_000 })
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const tailResponse = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await tailResponse.promise)
        const getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))
        const api = createApi(getMessages)
        api.getMessageContext = getMessageContext

        const loading = loadMessageContext(api, id, 'target')
        const syncing = syncTailMessages(api, id)
        await Promise.resolve()
        expect(getMessageContext).not.toHaveBeenCalled()

        tailResponse.resolve(latestResponse([latest], { epoch: 7 }))
        await syncing
        await expect(loading).resolves.toBe(true)
        expect(getMessageContext).toHaveBeenCalledWith(id, 'target')
    })

    it('waits for an active tail reconciliation before loading the searched context', async () => {
        const id = sessionId('search-context-tail-race')
        const latest = makeAgentMessage({ id: 'latest', seq: 100, at: 100_000 })
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const tailResponse = deferred<MessagesResponse>()
        const getMessages = vi.fn(async () => await tailResponse.promise)
        const getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))
        const api = createApi(getMessages)
        api.getMessageContext = getMessageContext

        const syncing = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessageWindowState(id).isSyncingTail).toBe(true))
        const loading = loadMessageContext(api, id, 'target')
        await Promise.resolve()
        expect(getMessageContext).not.toHaveBeenCalled()

        tailResponse.resolve(latestResponse([latest], { epoch: 7 }))
        await syncing
        await expect(loading).resolves.toBe(true)
        expect(getMessageContext).toHaveBeenCalledWith(id, 'target')
    })

    it('loads a bounded context, enters history mode, and preserves the latest reset boundary', async () => {
        const id = sessionId('search-context')
        const latest = makeAgentMessage({ id: 'latest', seq: 100, at: 100_000 })
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const before = makeAgentMessage({ id: 'before', seq: 39, at: 39_000 })
        const after = makeAgentMessage({ id: 'after', seq: 41, at: 41_000 })
        const getMessages = vi.fn(async () => latestResponse([latest], { epoch: 7 }))
        const getMessageContext = vi.fn(async () => contextResponse([before, target, after], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 39_000,
            nextBeforeSeq: 39,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: 'target'
        }))
        const api = createApi(getMessages)
        api.getMessageContext = getMessageContext

        await syncTailMessages(api, id)
        const historyVersion = getMessageWindowState(id).historyVersion

        await expect(loadMessageContext(api, id, 'target')).resolves.toBe(true)

        expect(getMessageContext).toHaveBeenCalledWith(id, 'target')
        expect(getMessageWindowState(id)).toMatchObject({
            messages: [before, target, after],
            hasMore: true,
            viewMode: 'history',
            isLoadingMore: false,
            historyVersion: historyVersion + 1
        })

        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id)).toMatchObject({
            viewMode: 'tail',
            epoch: null
        })
    })

    it('preserves acknowledgement and SSE updates received during a context request', async () => {
        const id = sessionId('search-context-concurrent-updates')
        const queued = makeUserMessage({
            id: 'queued',
            seq: 1,
            localId: 'queued-local',
            createdAt: 1_000,
            invokedAt: null,
            status: 'queued'
        })
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const concurrent = makeAgentMessage({ id: 'concurrent', seq: 41, at: 41_000 })
        ingestIncomingMessages(id, [queued])

        const response = deferred<MessageContextResponse>()
        const getMessageContext = vi.fn(async () => await response.promise)
        const api = createApi(vi.fn(async () => latestResponse([])))
        api.getMessageContext = getMessageContext

        const loading = loadMessageContext(api, id, target.id)
        await vi.waitFor(() => expect(getMessageContext).toHaveBeenCalledWith(id, target.id))

        markMessagesConsumed(id, ['queued-local'], 5_000)
        ingestIncomingMessages(id, [concurrent])

        response.resolve(contextResponse([target], {
            epoch: 7,
            hasMore: false,
            nextBeforeAt: 40_000,
            nextBeforeSeq: 40,
            snapshotHeadAt: 41_000,
            snapshotHeadSeq: 41,
            targetMessageId: target.id
        }))

        await expect(loading).resolves.toBe(true)

        expect(getMessageWindowState(id).messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: queued.id, status: 'sent', invokedAt: 5_000 }),
            expect.objectContaining({ id: concurrent.id }),
            expect.objectContaining({ id: target.id })
        ]))
    })

    it('does not persist a stale latest-reset boundary for historical contexts', async () => {
        const id = sessionId('search-context-persistence')
        const target = makeAgentMessage({ id: 'target', seq: 40, at: 40_000 })
        const getMessageContext = vi.fn(async () => contextResponse([target], {
            epoch: 7,
            hasMore: true,
            nextBeforeAt: 39_000,
            nextBeforeSeq: 39,
            snapshotHeadAt: 100_000,
            snapshotHeadSeq: 100,
            targetMessageId: target.id
        }))
        const api = createApi(vi.fn(async () => latestResponse([])))
        api.getMessageContext = getMessageContext

        await expect(loadMessageContext(api, id, target.id)).resolves.toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 250))

        const raw = sessionStorage.getItem(`hapi:message-window:v2:${id}`)
        expect(raw).toBeNull()

        const reloadedId = sessionId('search-context-persistence-reloaded')
        expect(getMessageWindowState(reloadedId).messages).toEqual([])
        expect(getMessageWindowState(reloadedId).requiresLatestReset).toBe(false)
    })

    it('forces a latest reset for legacy cached windows without the persisted flag', () => {
        const id = sessionId('legacy-history-cache')
        sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
            messages: [makeAgentMessage({ id: 'legacy', seq: 40, at: 40_000 })],
            hasMore: true,
            oldestPositionAt: 40_000,
            oldestPositionSeq: 40,
        }))

        expect(getMessageWindowState(id).requiresLatestReset).toBe(true)
    })

    it('does not replace the current window when the target disappeared', async () => {
        const id = sessionId('search-context-missing')
        const latest = makeAgentMessage({ id: 'latest', seq: 1, at: 1_000 })
        const getMessages = vi.fn(async () => latestResponse([latest], { epoch: 1 }))
        const getMessageContext = vi.fn(async () => contextResponse([latest], {
            epoch: 1,
            hasMore: false,
            nextBeforeAt: 1_000,
            nextBeforeSeq: 1,
            snapshotHeadAt: 1_000,
            snapshotHeadSeq: 1,
            targetMessageId: 'missing'
        }))
        const api = createApi(getMessages)
        api.getMessageContext = getMessageContext

        await syncTailMessages(api, id)
        await expect(loadMessageContext(api, id, 'missing')).resolves.toBe(false)

        expect(getMessageWindowState(id)).toMatchObject({
            messages: [latest],
            isLoadingMore: false,
            viewMode: 'tail'
        })
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

    it('keeps streamed rows after navigation ends at the conversation start without a gap', () => {
        const id = sessionId('navigation-overflow-after')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: HISTORY_WINDOW_SIZE + 50 }, (_, index) =>
            makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        ))
        releaseNavigation()
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'one-more', seq: HISTORY_WINDOW_SIZE + 60, at: HISTORY_WINDOW_SIZE + 60 }),
            makeUsageMessage({ id: 'one-more-usage', seq: HISTORY_WINDOW_SIZE + 61, at: HISTORY_WINDOW_SIZE + 61 })
        ])

        const state = getMessageWindowState(id)
        expect(state.messages).toHaveLength(HISTORY_WINDOW_SIZE + 52)
        expect(state.messages[0]?.id).toBe('overflow-0')
        expect(latestUsage(state.messages)).toMatchObject({ inputTokens: 4242 })
    })

    it('preserves navigation ownership and the leased window during programmatic bottom events', () => {
        const id = sessionId('navigation-preserves-ownership-on-bottom')
        setMessageViewMode(id, 'history')
        const releaseNavigation = beginNavigation(id)
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(1)
        // Programmatic bottom events (such as those fired during prepend
        // rendering) must not clear the lease or switch to tail mode.
        setMessageViewMode(id, 'tail')
        expect(getMessageWindowState(id).viewMode).toBe('history')
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(1)
        // Releasing the lease resumes normal tail handling.
        releaseNavigation()
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(0)
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

    it('drains a required epoch reset after navigation ends in history mode', async () => {
        const id = sessionId('navigation-drains-epoch-reset-in-history')
        const old = makeAgentMessage({ id: 'old', seq: 1, at: 1_000 })
        const fresh = makeAgentMessage({ id: 'fresh', seq: 2, at: 2_000 })
        const getMessages = vi.fn()
            .mockResolvedValueOnce(latestResponse([old], { epoch: 1 }))
            .mockResolvedValueOnce(latestResponse([fresh], { epoch: 2, reset: true }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id).epoch).toBe(1)

        setMessageViewMode(id, 'history')
        const releaseNavigation = beginNavigation(id)

        // Reset marks the window stale while navigating
        invalidateMessageWindow(id)
        expect(getMessageWindowState(id).epoch).toBeNull()
        await syncTailMessages(api, id)

        // Tail sync should not run while lease is held
        expect(getMessages).toHaveBeenCalledTimes(1)

        // Release navigation lease while remaining in history mode
        releaseNavigation()

        // The required epoch reset must be drained even though viewMode is history
        await vi.waitFor(() => {
            const state = getMessageWindowState(id)
            expect(state.epoch).toBe(2)
            expect(state.viewMode).toBe('history')
            expect(state.messages.map((message) => message.id)).toEqual(['fresh'])
        })
    })

    it('defers trim-induced tail resets across a second navigation while reading history', async () => {
        const id = sessionId('navigation-trim-induced-deferred')
        const getMessages = vi.fn().mockResolvedValue(latestResponse([
            makeAgentMessage({ id: 'latest', seq: 1000, at: 1000 })
        ], { epoch: 1 }))
        const api = createApi(getMessages)
        await syncTailMessages(api, id)
        expect(getMessages).toHaveBeenCalledTimes(1)

        // Enter history mode and hold a navigation lease
        setMessageViewMode(id, 'history')
        const releaseNav1 = beginNavigation(id, true)
        releaseNav1()

        // Stream in newer messages past the protected history cap (OLDER_LOAD_WINDOW_SIZE = 800)
        // In history mode, prepend trim drops newest rows and sets trim-induced requiresLatestReset
        const overflow = Array.from({ length: 900 }, (_, i) =>
            makeAgentMessage({ id: `stream-${i}`, seq: 1001 + i, at: 1001 + i })
        )
        ingestIncomingMessages(id, overflow)

        // Trim-induced reset must remain deferred; older history must not be replaced
        expect(getMessages).toHaveBeenCalledTimes(1)
        expect(getMessageWindowState(id).viewMode).toBe('history')

        // Second navigation begins and ends in history mode
        const releaseNav2 = beginNavigation(id, true)
        releaseNav2()

        // Still deferred — no tail sync or replacement while in history mode
        expect(getMessages).toHaveBeenCalledTimes(1)

        // Only returning to tail triggers the deferred replenishment
        setMessageViewMode(id, 'tail')
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
    })

    it('stops failed required resets from retrying indefinitely', async () => {
        const id = sessionId('navigation-failed-reset-no-infinite-retry')
        const getMessages = vi.fn().mockRejectedValue(new Error('Network error'))
        const api = createApi(getMessages)

        invalidateMessageWindow(id)
        expect(getMessageWindowState(id).epoch).toBeNull()

        // Explicit tail sync fails
        await syncTailMessages(api, id)

        // Must have been attempted exactly once without entering a retry loop
        expect(getMessages).toHaveBeenCalledTimes(1)

        // Error warning preserved on window state
        const state = getMessageWindowState(id)
        expect(state.warning).toBe('Network error')
        expect(state.isSyncingTail).toBe(false)

        // Verify no delayed retry fired
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(getMessages).toHaveBeenCalledTimes(1)
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

    it('keeps the prompt of the turn the retained tail starts in', () => {
        const id = sessionId('navigation-tail-prompt')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 50
        const tailStartSeq = total - VISIBLE_WINDOW_SIZE + 2
        ingestIncomingMessages(id, Array.from({ length: total }, (_, index) => index + 2 === tailStartSeq - 5
            ? makeUserMessage({ id: 'tail-prompt', seq: index + 2, createdAt: index + 2, invokedAt: index + 2 })
            : makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
        ))

        const ids = getMessageWindowState(id).messages.map((message) => message.id)
        const promptIndex = ids.indexOf('tail-prompt')
        expect(ids[promptIndex - 1]).toMatch(/^__transcript-gap__/)
        // The rows skipped inside the turn are marked, not silently dropped.
        expect(ids[promptIndex + 1]).toBe(`__transcript-gap__${tailStartSeq - 4}-${tailStartSeq - 1}~turn`)
        expect(ids[promptIndex + 2]).toBe(`overflow-${tailStartSeq - 2}`)

        // A re-trim of the already-trimmed window keeps both boundaries.
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'next', seq: total + 2, at: total + 2 })])
        const retrimmed = getMessageWindowState(id).messages.map((message) => message.id)
        const retrimmedPrompt = retrimmed.indexOf('tail-prompt')
        expect(retrimmed[retrimmedPrompt - 1]).toBe(ids[promptIndex - 1])
        expect(retrimmed[retrimmedPrompt + 1]).toMatch(/^__transcript-gap__.*~turn$/)
        releaseNavigation()
    })

    it('marks the gap inside one long turn whose prompt is in the head', () => {
        const id = sessionId('navigation-long-turn')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 50
        ingestIncomingMessages(id, [
            makeUserMessage({ id: 'only-prompt', seq: 1, createdAt: 1, invokedAt: 1 }),
            ...Array.from({ length: total }, (_, index) =>
                makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
            )
        ])

        const gaps = getMessageWindowState(id).messages.filter((message) => message.id.startsWith('__transcript-gap__'))
        expect(gaps.map((message) => message.id)).toEqual([expect.stringMatching(/~turn$/)])
        releaseNavigation()
    })

    it('treats agent-wrapped user text as a turn prompt', () => {
        const id = sessionId('navigation-wrapped-prompt')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 50
        // A prompt typed in the terminal arrives as agent output but renders as user text.
        const wrappedSeq = HISTORY_WINDOW_SIZE + 10
        ingestIncomingMessages(id, [
            makeUserMessage({ id: 'head-prompt', seq: 1, createdAt: 1, invokedAt: 1 }),
            ...Array.from({ length: total }, (_, index) => index + 2 === wrappedSeq
                ? {
                    ...makeAgentMessage({ id: 'wrapped-prompt', seq: wrappedSeq, at: wrappedSeq }),
                    content: {
                        role: 'agent',
                        content: { type: 'output', data: { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'typed' }] } } }
                    }
                } as DecryptedMessage
                : makeAgentMessage({ id: `overflow-${index}`, seq: index + 2, at: index + 2 })
            )
        ])

        const ids = getMessageWindowState(id).messages.map((message) => message.id)
        // It starts the tail's turn, so it is kept; otherwise a single in-turn
        // gap would link the tail back to head-prompt.
        expect(ids).toContain('wrapped-prompt')
        releaseNavigation()
    })

    it('does not keep a failed send as the tail turn prompt', () => {
        const id = sessionId('navigation-tail-failed-send')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 50
        const tailStartSeq = total - VISIBLE_WINDOW_SIZE + 2
        ingestIncomingMessages(id, Array.from({ length: total }, (_, index) => {
            const seq = index + 2
            if (seq === tailStartSeq - 10) return makeUserMessage({ id: 'tail-prompt', seq, createdAt: seq, invokedAt: seq })
            if (seq === tailStartSeq - 2) return makeUserMessage({ id: 'failed-send', seq, createdAt: seq, invokedAt: seq, status: 'failed' })
            return makeAgentMessage({ id: `overflow-${index}`, seq, at: seq })
        }))

        const ids = getMessageWindowState(id).messages.map((message) => message.id)
        expect(ids).toContain('tail-prompt')
        expect(ids).not.toContain('failed-send')
        releaseNavigation()
    })

    it('marks omitted rows by display order, not seq adjacency', () => {
        const id = sessionId('navigation-late-invoked-prompt')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')
        const total = HISTORY_WINDOW_SIZE + VISIBLE_WINDOW_SIZE + 50
        const agents = Array.from({ length: total }, (_, index) => {
            const seq = index + 2 >= HISTORY_WINDOW_SIZE + 2 ? index + 3 : index + 2
            return makeAgentMessage({ id: `overflow-${index}`, seq, at: index + 2 })
        })
        // Seq follows the head's last row, but it was invoked after 40 newer agent rows.
        const latePrompt = makeUserMessage({
            id: 'late-prompt',
            seq: HISTORY_WINDOW_SIZE + 2,
            createdAt: HISTORY_WINDOW_SIZE + 40.5,
            invokedAt: HISTORY_WINDOW_SIZE + 40.5
        })
        ingestIncomingMessages(id, [...agents, latePrompt])

        const ids = getMessageWindowState(id).messages.map((message) => message.id)
        const promptIndex = ids.indexOf('late-prompt')
        expect(ids[promptIndex - 1]).toMatch(/^__transcript-gap__/)
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
        expect(state.messages.some((message) => message.id.startsWith('__transcript-gap__'))).toBe(true)
        releaseNavigation()
    })

    it('preserves parents of retained subagent messages across navigation trimming', () => {
        const id = sessionId('navigation-preserves-subagent-parents')
        const releaseNavigation = beginNavigation(id)
        setMessageViewMode(id, 'history')

        const claudeOutput = (msgId: string, seq: number, data: Record<string, unknown>) => ({
            id: msgId,
            seq,
            localId: null,
            content: { role: 'agent', content: { type: 'output', data } },
            createdAt: seq,
            invokedAt: seq
        } as DecryptedMessage)

        // Head messages: 1 to HISTORY_WINDOW_SIZE (600)
        const head = Array.from({ length: HISTORY_WINDOW_SIZE }, (_, index) =>
            makeAgentMessage({ id: `head-${index}`, seq: index + 1, at: index + 1 })
        )
        // Parent tool call placed in the middle gap (seq 650) that gets dropped by navigation trimming
        const parent = claudeOutput('agent-call', HISTORY_WINDOW_SIZE + 50, {
            type: 'assistant',
            uuid: 'agent-call',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_nav_agent', name: 'Agent', input: { prompt: 'work' } }] }
        })
        const middle = Array.from({ length: 49 }, (_, index) =>
            makeAgentMessage({ id: `mid-${index}`, seq: HISTORY_WINDOW_SIZE + 1 + index, at: HISTORY_WINDOW_SIZE + 1 + index })
        )
        // Tail messages (VISIBLE_WINDOW_SIZE = 400), with a sidechain row referencing the parent
        const tailStartSeq = HISTORY_WINDOW_SIZE + 100
        const sidechain = claudeOutput('sidechain-row', tailStartSeq + 10, {
            type: 'assistant',
            uuid: 'sidechain-row',
            isSidechain: true,
            parentToolUseId: 'toolu_nav_agent',
            message: { role: 'assistant', content: [{ type: 'text', text: 'subagent task progress' }] }
        })
        const tail = Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) => {
            const seq = tailStartSeq + index
            if (seq === tailStartSeq + 10) return sidechain
            return makeAgentMessage({ id: `tail-${index}`, seq, at: seq })
        })

        ingestIncomingMessages(id, [...head, ...middle, parent, ...tail])

        const state = getMessageWindowState(id)
        // The parent tool call in the middle must survive trimming because its child sidechain is kept in the tail
        expect(state.messages.some((message) => message.id === 'agent-call')).toBe(true)
        expect(state.messages.some((message) => message.id === 'sidechain-row')).toBe(true)
        expect(state.messages.some((message) => message.id.startsWith('__transcript-gap__'))).toBe(true)
        releaseNavigation()
    })

    it('preserves a gap through agent-run and replacement reasoning updates', () => {
        const id = sessionId('navigation-gap-updates')
        const release = beginNavigation(id)
        ingestIncomingMessages(id, [
            ...Array.from({ length: 1100 }, (_, index) =>
                makeAgentMessage({ id: `row-${index}`, seq: index + 1, at: index + 1 })),
            makeReasoningMessage('reasoning-old', 'stream', 1101, 1101)
        ])
        const gapId = getMessageWindowState(id).messages.find(message => message.id.startsWith('__transcript-gap__'))!.id
        for (const message of [
            makeAgentRunMessage('run', 1102, 1102),
            makeReasoningMessage('reasoning-new', 'stream', 1103, 1103)
        ]) {
            ingestIncomingMessages(id, [message])
            expect(getMessageWindowState(id).messages.some(message => message.id === gapId)).toBe(true)
        }
        release()
    })

    it('preserves a retained tail target after navigation hands off to history browsing', () => {
        const id = sessionId('navigation-browsing-handoff')
        const releaseStart = beginNavigation(id)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: 1200 }, (_, index) =>
            makeAgentMessage({ id: `row-${index}`, seq: index + 1, at: index + 1 })))
        releaseStart()
        const releaseTarget = beginNavigation(id, true)
        releaseTarget()
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(0)
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'live', seq: 1201, at: 1201 })])
        expect(getMessageWindowState(id).messages.some(message => message.id === 'row-900')).toBe(true)
        setMessageViewMode(id, 'tail')
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'after', seq: 1202, at: 1202 })])
        expect(getMessageWindowState(id).messages.length).toBeLessThanOrEqual(VISIBLE_WINDOW_SIZE)
    })

    it('keeps live usage current after a prompt jump installs a browsing boundary', () => {
        const id = sessionId('navigation-prompt-live-usage')
        const release = beginNavigation(id, true)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: 900 }, (_, index) =>
            makeAgentMessage({ id: `row-${index}`, seq: index + 1, at: index + 1 })))
        release()
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'live', seq: 901, at: 901 }),
            makeUsageMessage({ id: 'live-usage', seq: 902, at: 902 })
        ])

        const state = getMessageWindowState(id)
        expect(state.messages.some(message => message.id === 'row-450')).toBe(true)
        expect(state.messages.some(message => message.id === 'live-usage')).toBe(false)
        expect(state.liveUsage).toMatchObject({ inputTokens: 4242, timestamp: 902 })
    })

    it('keeps live usage after conversation-start navigation completes', () => {
        const id = sessionId('navigation-start-live-usage')
        const releaseStart = beginNavigation(id)
        setMessageViewMode(id, 'history')
        ingestIncomingMessages(id, Array.from({ length: 1200 }, (_, index) =>
            makeAgentMessage({ id: `row-${index}`, seq: index + 1, at: index + 1 })))
        releaseStart()
        ingestIncomingMessages(id, [
            makeAgentMessage({ id: 'live', seq: 1201, at: 1201 }),
            makeUsageMessage({ id: 'live-usage', seq: 1202, at: 1202 })
        ])

        const state = getMessageWindowState(id)
        expect(state.messages[0]?.id).toBe('row-0')
        expect(state.messages.at(-1)?.id).toBe('live-usage')
        expect(latestUsage(state.messages)).toMatchObject({ inputTokens: 4242 })
    })

    it('preserves middle targets for overlapping outline leases and restores normal trimming afterward', () => {
        const id = sessionId('outline-middle-target')
        const first = beginNavigation(id, true)
        const second = beginNavigation(id, true)
        ingestIncomingMessages(id, Array.from({ length: 1200 }, (_, index) =>
            makeAgentMessage({ id: `row-${index}`, seq: index + 1, at: index + 1 })))
        first()
        first()
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'live', seq: 1201, at: 1201 })])
        expect(getMessageWindowState(id).messages).toHaveLength(1201)
        expect(getMessageWindowState(id).messages.some(message => message.id === 'row-700')).toBe(true)
        second()
        ingestIncomingMessages(id, [makeAgentMessage({ id: 'after', seq: 1202, at: 1202 })])
        expect(getMessageWindowState(id).messages.length).toBeLessThanOrEqual(VISIBLE_WINDOW_SIZE)
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
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(2)
        // One lease released: the window must still have a lease held.
        first()
        expect(getMessageWindowState(id).navigationLeaseCount).toBe(1)
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
