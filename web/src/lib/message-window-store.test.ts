import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage, MessageStatus } from '@/types/api'

function userMessage(input: {
    id: string
    seq: number | null
    localId: string | null
    text: string
    status?: MessageStatus
}): DecryptedMessage {
    return {
        id: input.id,
        seq: input.seq,
        localId: input.localId,
        createdAt: 1_000,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: input.text
            }
        },
        status: input.status,
        originalText: input.text
    }
}

describe('message-window-store', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    it('updates status after a stored message replaces its optimistic bubble', async () => {
        const store = await import('./message-window-store')
        const sessionId = 'session-1'
        const localId = 'local-1'

        store.appendOptimisticMessage(sessionId, userMessage({
            id: localId,
            seq: null,
            localId,
            text: 'hello',
            status: 'sending'
        }))

        store.ingestIncomingMessages(sessionId, [
            userMessage({
                id: 'message-1',
                seq: 1,
                localId,
                text: 'hello'
            })
        ])

        store.updateMessageStatus(sessionId, localId, 'sent')

        const state = store.getMessageWindowState(sessionId)
        expect(state.messages).toHaveLength(1)
        expect(state.messages[0]).toMatchObject({
            id: 'message-1',
            localId,
            status: 'sent'
        })
    })
})
