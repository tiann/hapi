import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

describe('cancelQueuedMessage', () => {
    it('happy path: deletes queued message, returns status=cancelled with localId', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-happy')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-1')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-1')
        }

        // Row should be gone from uninvoked list
        const remaining = store.messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
    })

    it('already-invoked: returns status=invoked, row stays in DB', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-already-invoked')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-2')

        // Simulate CLI invoke ack
        store.messages.markMessagesInvoked(session.id, ['lid-2'], Date.now())

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('invoked')

        // Row still exists (with invoked_at set)
        const messages = store.messages.getMessages(session.id)
        expect(messages.some(m => m.id === msg.id)).toBe(true)
    })

    it('cancel × 2 idempotent: second call returns status=cancelled with localId=null (row gone)', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-idempotent')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-3')

        const first = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe('lid-3')
        }

        const second = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
    })

    it('non-existent messageId: returns status=cancelled with localId=null', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-nonexistent')

        const result = store.messages.cancelQueuedMessage(session.id, 'nonexistent-id')
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }
    })

    it('wrong sessionId: returns status=cancelled with localId=null, message from other session untouched', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'cancel-session-a')
        const sessionB = makeSession(store, 'cancel-session-b')
        const msg = store.messages.addMessage(sessionA.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-A')

        const result = store.messages.cancelQueuedMessage(sessionB.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }

        // Original message still exists
        const remaining = store.messages.getUninvokedLocalMessages(sessionA.id)
        expect(remaining).toHaveLength(1)
    })

    it('cancelled localId is propagated from the deleted row', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-localid-propagate')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-propagate')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-propagate')
        }
    })
})
