import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import {
    clearMessageWindow,
    fetchOlderMessages,
    getMessageWindowState,
    ingestIncomingMessages,
    syncTailMessages,
} from '@/lib/message-window-store'
import { useMessages } from './useMessages'

const sessionId = 'use-messages-route-cleanup'

function makeAgentMessage(seq: number): DecryptedMessage {
    return {
        id: `message-${seq}`,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'text', text: `message ${seq}` },
            },
        },
        createdAt: seq,
        invokedAt: seq,
    } as DecryptedMessage
}

function latestResponse(messages: DecryptedMessage[]): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'latest',
            limit: 200,
            epoch: 1,
            reset: false,
            nextBeforeSeq: 401,
            nextBeforeAt: 401,
            nextAfterSeq: 600,
            nextAfterAt: 600,
            snapshotHeadSeq: 600,
            snapshotHeadAt: 600,
            hasMore: true,
        },
    }
}

function beforeResponse(messages: DecryptedMessage[], hasMore: boolean): MessagesResponse {
    const first = messages[0]
    return {
        messages,
        page: {
            direction: 'before',
            limit: 200,
            epoch: 1,
            reset: false,
            nextBeforeSeq: first?.seq ?? null,
            nextBeforeAt: first?.createdAt ?? null,
            nextAfterSeq: null,
            nextAfterAt: null,
            snapshotHeadSeq: null,
            snapshotHeadAt: null,
            hasMore,
        },
    }
}

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

afterEach(() => {
    clearMessageWindow(sessionId)
    vi.restoreAllMocks()
})

describe('useMessages route cleanup', () => {
    it('releases a tail history boundary when the chat view unmounts', async () => {
        const allMessages = Array.from({ length: 600 }, (_, index) => makeAgentMessage(index + 1))
        const getMessages = vi.fn(async (_id: string, query: { beforeSeq?: number | null }) => {
            const beforeSeq = query.beforeSeq
            if (beforeSeq != null) {
                const older = allMessages.filter((message) => (message.seq ?? 0) < beforeSeq)
                return beforeResponse(older.slice(-200), older.length > 200)
            }
            return latestResponse(allMessages.slice(-200))
        })
        const api = { getMessages } as unknown as ApiClient

        await syncTailMessages(api, sessionId)
        const hook = renderHook(() => useMessages(null, sessionId), {
            wrapper: createWrapper(),
        })

        await act(async () => {
            const outcome = await fetchOlderMessages(api, sessionId, {
                shouldInstallBoundary: () => true,
            })
            expect(outcome.kind).toBe('applied')
        })
        ingestIncomingMessages(sessionId, [makeAgentMessage(601)])
        expect(getMessageWindowState(sessionId).messages).toHaveLength(401)

        hook.unmount()
        for (let seq = 602; seq <= 801; seq += 1) {
            ingestIncomingMessages(sessionId, [makeAgentMessage(seq)])
        }

        const state = getMessageWindowState(sessionId)
        expect(state.viewMode).toBe('tail')
        expect(state.messages).toHaveLength(400)
        expect(state.messages.at(-1)?.seq).toBe(801)
    })

    it('invalidates an in-flight older load when the chat view unmounts', async () => {
        const allMessages = Array.from({ length: 600 }, (_, index) => makeAgentMessage(index + 1))
        const pending = deferred<MessagesResponse>()
        let olderPageCall = 0
        const getMessages = vi.fn(async (_id: string, query: { beforeSeq?: number | null }) => {
            const beforeSeq = query.beforeSeq
            if (beforeSeq != null) {
                if (olderPageCall++ > 0) {
                    return await pending.promise
                }
                const older = allMessages.filter((message) => (message.seq ?? 0) < beforeSeq)
                return beforeResponse(older.slice(-200), older.length > 200)
            }
            return latestResponse(allMessages.slice(-200))
        })
        const api = { getMessages } as unknown as ApiClient

        await syncTailMessages(api, sessionId)
        const hook = renderHook(() => useMessages(null, sessionId), {
            wrapper: createWrapper(),
        })
        await fetchOlderMessages(api, sessionId, { shouldInstallBoundary: () => true })

        const load = fetchOlderMessages(api, sessionId, { shouldInstallBoundary: () => true })
        hook.unmount()
        pending.resolve(beforeResponse(allMessages.slice(0, 200), false))

        await expect(load).resolves.toEqual({ kind: 'stopped', reason: 'invalidated' })
        expect(getMessageWindowState(sessionId).messages).toHaveLength(400)
    })
})

const searchSessionId = 'use-messages-search-target-cache'

afterEach(() => {
    clearMessageWindow(searchSessionId)
    sessionStorage.clear()
})

describe('useMessages search-target initialization', () => {
    it('enters history mode before skipping the initial tail for a legacy cached window', async () => {
        const cachedMessage = {
            id: 'cached-message',
            role: 'agent',
            content: { type: 'text', text: 'cached message' },
            createdAt: 1_000,
            seq: 1,
            invokedAt: 1_000,
        } as unknown as DecryptedMessage
        sessionStorage.setItem(`hapi:message-window:v2:${searchSessionId}`, JSON.stringify({
            messages: [cachedMessage],
            hasMore: true,
            oldestPositionAt: 1_000,
            oldestPositionSeq: 1,
            newestPositionAt: 1_000,
            newestPositionSeq: 1,
            epoch: 1,
            requiresLatestReset: true,
        }))
        const api = { getMessages: vi.fn() } as unknown as ApiClient

        const { result } = renderHook(() => useMessages(api, searchSessionId, {
            skipInitialTailSync: true,
        }))

        await waitFor(() => expect(result.current.isSyncingTail).toBe(false))
        expect(result.current.viewMode).toBe('history')
        expect(result.current.messages).toEqual([cachedMessage])
        expect(api.getMessages).not.toHaveBeenCalled()
    })
})
