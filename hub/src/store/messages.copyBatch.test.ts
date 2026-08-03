import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('copyMessagesToSession', () => {
    it('copies a prefix in one transaction and bumps epoch once', () => {
        const store = new Store(':memory:')
        const source = store.sessions.getOrCreateSession('src', { path: '/tmp' }, null, 'default')
        const child = store.sessions.getOrCreateSession('child', { path: '/tmp' }, null, 'default')

        store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'one' } }, 'local-1')
        store.messages.markMessagesInvoked(source.id, ['local-1'], Date.now())
        store.messages.addMessage(source.id, { role: 'agent', content: { type: 'text', text: 'a1' } })
        store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'two' } }, 'local-2')
        store.messages.markMessagesInvoked(source.id, ['local-2'], Date.now())

        const beforeEpoch = store.messages.getMessageEpoch(child.id)
        const prefix = store.messages.getAllMessages(source.id).slice(0, 2)
        const copied = store.messages.copyMessagesToSession(
            child.id,
            prefix.map((message) => ({
                content: message.content,
                createdAt: message.createdAt,
                localId: message.localId,
                invokedAt: message.invokedAt,
                scheduledAt: message.scheduledAt
            }))
        )

        expect(copied).toBe(2)
        expect(store.messages.getAllMessages(child.id)).toHaveLength(2)
        expect(store.messages.getMessageEpoch(child.id)).toBe(beforeEpoch + 1)
    })
})
