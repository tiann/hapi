import { afterEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import {
    appendOptimisticMessage,
    clearMessageWindow,
    fetchLatestMessages,
    getMessageWindowState,
    ingestIncomingMessages,
    markMessagesConsumed,
    removeOptimisticMessage,
    VISIBLE_WINDOW_SIZE,
    updateMessageStatus,
} from '@/lib/message-window-store'

function makeMsg(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    const id = overrides.id ?? 'msg-1'
    return {
        id,
        seq: null,
        localId: overrides.localId ?? id,
        content: {
            role: 'user',
            content: { type: 'text', text: 'hello' }
        },
        createdAt: Date.now(),
        invokedAt: null,
        status: 'queued',
        ...overrides,
    }
}

function makeUserMessage(props: {
    id: string
    seq?: number | null
    localId?: string
    status?: MessageStatus
    text?: string
    createdAt?: number
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq ?? null,
        localId: props.localId ?? null,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: props.text ?? 'hello',
            },
        },
        createdAt: props.createdAt ?? Date.now(),
        status: props.status,
        originalText: props.text ?? 'hello',
    } as DecryptedMessage
}

function makeAgentMessage(props: {
    id: string
    seq?: number | null
    createdAt?: number
    text?: string
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq ?? null,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: props.text ?? 'agent text'
                }
            }
        },
        createdAt: props.createdAt ?? Date.now(),
        invokedAt: props.createdAt ?? Date.now()
    } as DecryptedMessage
}

function makeAgentRunMessage(props: {
    id: string
    seq?: number | null
    createdAt?: number
    eventType?: 'agent-run-start' | 'agent-run-update' | 'agent-run-trace'
}): DecryptedMessage {
    const eventType = props.eventType ?? 'agent-run-update'
    return {
        id: props.id,
        seq: props.seq ?? null,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: eventType,
                    cardId: 'spawn-1',
                    agentId: 'agent-1',
                    status: 'running',
                    activity: 'Running'
                }
            }
        },
        createdAt: props.createdAt ?? Date.now(),
        invokedAt: props.createdAt ?? Date.now()
    } as DecryptedMessage
}

describe('removeOptimisticMessage', () => {
    const SESSION = 'test-session-remove'

    afterEach(() => {
        clearMessageWindow(SESSION)
    })

    it('removes a message matched by localId from the messages list', () => {
        const msg = makeMsg({ id: 'msg-a', localId: 'local-a' })
        appendOptimisticMessage(SESSION, msg)

        removeOptimisticMessage(SESSION, 'local-a')

        const state = getMessageWindowState(SESSION)
        expect(state.messages.find((m) => m.id === 'msg-a')).toBeUndefined()
    })

    it('removes a message matched by id (when localId equals id)', () => {
        const msg = makeMsg({ id: 'msg-b', localId: 'msg-b' })
        appendOptimisticMessage(SESSION, msg)

        removeOptimisticMessage(SESSION, 'msg-b')

        const state = getMessageWindowState(SESSION)
        expect(state.messages).toHaveLength(0)
    })

    it('is a no-op when localId does not match any message', () => {
        const msg = makeMsg({ id: 'msg-c', localId: 'local-c' })
        appendOptimisticMessage(SESSION, msg)

        removeOptimisticMessage(SESSION, 'nonexistent')

        const state = getMessageWindowState(SESSION)
        expect(state.messages).toHaveLength(1)
    })

    it('is a no-op when called with an empty string', () => {
        const msg = makeMsg({ id: 'msg-d', localId: 'local-d' })
        appendOptimisticMessage(SESSION, msg)

        removeOptimisticMessage(SESSION, '')

        const state = getMessageWindowState(SESSION)
        expect(state.messages).toHaveLength(1)
    })

    it('does not remove other messages when removing one', () => {
        const msgA = makeMsg({ id: 'msg-e1', localId: 'local-e1' })
        const msgB = makeMsg({ id: 'msg-e2', localId: 'local-e2' })
        appendOptimisticMessage(SESSION, msgA)
        appendOptimisticMessage(SESSION, msgB)

        removeOptimisticMessage(SESSION, 'local-e1')

        const state = getMessageWindowState(SESSION)
        expect(state.messages.find((m) => m.id === 'msg-e1')).toBeUndefined()
        expect(state.messages.find((m) => m.id === 'msg-e2')).toBeDefined()
    })

    it('is idempotent: second call is a no-op', () => {
        const msg = makeMsg({ id: 'msg-f', localId: 'local-f' })
        appendOptimisticMessage(SESSION, msg)

        removeOptimisticMessage(SESSION, 'local-f')
        removeOptimisticMessage(SESSION, 'local-f')

        const state = getMessageWindowState(SESSION)
        expect(state.messages).toHaveLength(0)
    })
})

describe('message-window-store status updates', () => {
    const SESSION_ID = 'session-message-window-store-test'

    afterEach(() => {
        clearMessageWindow(SESSION_ID)
    })

    it('updates stored user messages by localId after optimistic replacement', () => {
        appendOptimisticMessage(SESSION_ID, makeUserMessage({
            id: 'local-1',
            localId: 'local-1',
            status: 'sending',
        }))

        ingestIncomingMessages(SESSION_ID, [
            makeUserMessage({
                id: 'server-1',
                localId: 'local-1',
                createdAt: Date.now() + 1,
            }),
        ])

        updateMessageStatus(SESSION_ID, 'local-1', 'sent')

        const message = getMessageWindowState(SESSION_ID).messages.find((entry) => entry.id === 'server-1')
        expect(message?.status).toBe('sent')
    })

    it('marks stored queued messages as consumed by localId', () => {
        ingestIncomingMessages(SESSION_ID, [
            makeUserMessage({
                id: 'server-queued',
                localId: 'queued-1',
                status: 'queued',
            }),
        ])

        markMessagesConsumed(SESSION_ID, ['queued-1'], Date.now())

        const message = getMessageWindowState(SESSION_ID).messages.find((entry) => entry.id === 'server-queued')
        expect(message?.status).toBe('sent')
    })
})

describe('message-window-store visible trimming', () => {
    const SESSION_ID = 'session-message-window-trim-test'

    afterEach(() => {
        clearMessageWindow(SESSION_ID)
    })

    it('does not evict main conversation messages when Codex subagent events flood the window', () => {
        const baseTime = 1_700_000_000_000
        const messages: DecryptedMessage[] = [
            makeUserMessage({
                id: 'main-user',
                seq: 1,
                text: 'main prompt before subagents',
                createdAt: baseTime
            })
        ]

        for (let i = 0; i < VISIBLE_WINDOW_SIZE + 1; i += 1) {
            messages.push(makeAgentRunMessage({
                id: `agent-run-${i}`,
                seq: i + 2,
                createdAt: baseTime + i + 1
            }))
        }

        ingestIncomingMessages(SESSION_ID, messages)

        const state = getMessageWindowState(SESSION_ID)
        expect(state.messages.some((message) => message.id === 'main-user')).toBe(true)
        expect(state.messages.some((message) => message.id === 'agent-run-0')).toBe(true)
    })

    it('marks the window as pageable when regular live messages are trimmed', () => {
        const baseTime = 1_700_000_100_000
        const messages: DecryptedMessage[] = []
        for (let i = 0; i < VISIBLE_WINDOW_SIZE + 1; i += 1) {
            messages.push(makeAgentMessage({
                id: `agent-message-${i}`,
                seq: i + 1,
                createdAt: baseTime + i
            }))
        }

        ingestIncomingMessages(SESSION_ID, messages)

        const state = getMessageWindowState(SESSION_ID)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.some((message) => message.id === 'agent-message-0')).toBe(false)
        expect(state.hasMore).toBe(true)
        expect(state.oldestSeq).toBe(2)
    })

    it('backfills cold latest load when the newest page is filled by Codex subagent events', async () => {
        const baseTime = 1_700_000_200_000
        const latestAgentRuns: DecryptedMessage[] = []
        for (let i = 0; i < 50; i += 1) {
            latestAgentRuns.push(makeAgentRunMessage({
                id: `agent-run-latest-${i}`,
                seq: i + 2,
                createdAt: baseTime + i + 2
            }))
        }
        const mainMessage = makeUserMessage({
            id: 'main-user-before-agent-flood',
            seq: 1,
            text: 'main prompt before subagents',
            createdAt: baseTime + 1
        })

        const calls: Array<{ beforeAt?: number | null; beforeSeq?: number | null; limit?: number }> = []
        const api = {
            getMessages: async (_sessionId: string, options: { beforeAt?: number | null; beforeSeq?: number | null; limit?: number }) => {
                calls.push(options)
                if (calls.length === 1) {
                    return {
                        messages: latestAgentRuns,
                        page: {
                            limit: options.limit ?? 50,
                            nextBeforeSeq: 2,
                            nextBeforeAt: baseTime + 2,
                            hasMore: true
                        }
                    }
                }
                return {
                    messages: [mainMessage],
                    page: {
                        limit: options.limit ?? 200,
                        nextBeforeSeq: 1,
                        nextBeforeAt: baseTime + 1,
                        hasMore: false
                    }
                }
            }
        } as Pick<ApiClient, 'getMessages'>

        await fetchLatestMessages(api as ApiClient, SESSION_ID)

        const state = getMessageWindowState(SESSION_ID)
        expect(calls).toHaveLength(2)
        expect(calls[1]).toMatchObject({
            beforeSeq: 2,
            beforeAt: baseTime + 2,
            limit: 200
        })
        expect(state.messages.some((message) => message.id === 'main-user-before-agent-flood')).toBe(true)
        expect(state.messages.filter((message) => message.id.startsWith('agent-run-latest-'))).toHaveLength(50)
    })
})
