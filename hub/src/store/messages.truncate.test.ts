import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('truncateMessagesFromLocalId', () => {
    it('deletes the target and later messages and bumps epoch', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('t', { path: '/tmp' }, null, 'default')

        // Mirror real delivery order: invoke each user turn before its agent reply
        // is written. Bulk-stamping invokedAt after the fact collapses timestamps and
        // can leave later agent rows "before" the rewind boundary.
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'one' } }, 'local-1')
        store.messages.markMessagesInvoked(session.id, ['local-1'], Date.now())
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'a1' } })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'two' } }, 'local-2')
        store.messages.markMessagesInvoked(session.id, ['local-2'], Date.now())
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'a2' } })

        const beforeEpoch = store.messages.getMessageEpoch(session.id)
        const result = store.messages.truncateMessagesFromLocalId(session.id, 'local-2', [])
        expect(result.deleted).toBeGreaterThanOrEqual(2)
        expect(result.epoch).toBeGreaterThan(beforeEpoch)

        const remaining = store.messages.getAllMessages(session.id)
        expect(remaining.some((message) => message.localId === 'local-2')).toBe(false)
        expect(remaining.some((message) => message.localId === 'local-1')).toBe(true)
    })
})
