import { afterEach, describe, expect, it } from 'vitest'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import {
    appendOptimisticMessage,
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    markMessagesConsumed,
    updateMessageStatus,
} from '@/lib/message-window-store'

const SESSION_ID = 'session-message-window-store-test'

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

describe('message-window-store status updates', () => {
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
