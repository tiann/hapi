import { afterEach, describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { clearMessageWindow, getMessageWindowState, getQueuedReconcileCandidateLocalIds, ingestIncomingMessages, markMessagesConsumed, markMessagesDispatching, markMessagesIndeterminate, markMessagesRequeued } from './message-window-store'

const sessionId = 'delivery-state-transitions'
const message = () => getMessageWindowState(sessionId).messages[0]!
function seed() {
    ingestIncomingMessages(sessionId, [{ id: 'server-id', localId: 'local-id', seq: 1, createdAt: 1000, invokedAt: null, status: 'queued', content: { role: 'user', content: { type: 'text', text: 'correction' } } } as DecryptedMessage])
}
afterEach(() => clearMessageWindow(sessionId))

describe('delivery confirmation state', () => {
    it('retains the same durable identity through pending, unknown, and explicit requeue', () => {
        seed()
        markMessagesDispatching(sessionId, ['local-id'])
        expect(message()).toMatchObject({ id: 'server-id', localId: 'local-id', invokedAt: null, deliveryPending: true })
        markMessagesIndeterminate(sessionId, ['local-id'])
        expect(message().deliveryPending).toBeUndefined()
        expect(message().deliveryState).toBe('indeterminate')
        markMessagesRequeued(sessionId, ['local-id'])
        expect(message().deliveryState).toBeUndefined()
        expect(getMessageWindowState(sessionId).messages).toHaveLength(1)
    })

    it('clears pending on consumption and ignores late nonterminal events', () => {
        seed()
        markMessagesDispatching(sessionId, ['local-id'])
        markMessagesConsumed(sessionId, ['local-id'], 2000)
        markMessagesDispatching(sessionId, ['local-id'])
        markMessagesIndeterminate(sessionId, ['local-id'])
        expect(message()).toMatchObject({ id: 'server-id', invokedAt: 2000, status: 'sent' })
        expect(message().deliveryPending).toBeUndefined()
        expect(message().deliveryState).toBeUndefined()
        expect(getMessageWindowState(sessionId).messages).toHaveLength(1)
    })
})


it('treats an optimistic sent status as unconfirmed until invokedAt is recorded', () => {
    ingestIncomingMessages(sessionId, [{ id: 'server-id', localId: 'local-id', seq: 1, createdAt: 1000, invokedAt: null, status: 'sent', content: { role: 'user', content: { type: 'text', text: 'correction' } } } as DecryptedMessage])
    markMessagesDispatching(sessionId, ['local-id'])
    expect(message()).toMatchObject({ invokedAt: null, deliveryPending: true })
})


it('retains an optimistic sent row in reconnect candidates until invocation is confirmed', () => {
    ingestIncomingMessages(sessionId, [{ id: 'local-id', localId: 'local-id', seq: null, createdAt: 1000, invokedAt: null, status: 'sent', content: { role: 'user', content: { type: 'text', text: 'correction' } } } as DecryptedMessage])
    expect(getQueuedReconcileCandidateLocalIds(sessionId)).toEqual(['local-id'])
})
