import { afterEach, describe, expect, it } from 'vitest'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import {
    appendOptimisticMessage,
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    markMessagesConsumed,
    removeOptimisticMessage,
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
    localId?: string
    status?: MessageStatus
    text?: string
    createdAt?: number
}): DecryptedMessage {
    return {
        id: props.id,
        seq: null,
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
