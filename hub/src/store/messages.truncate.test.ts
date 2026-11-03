import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import type { Database } from 'bun:sqlite'

describe('truncateMessagesFromLocalId', () => {
    it('removes derived search rows only for the cutoff-bounded deleted suffix', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('bounded-search', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'pruneword qx' } }, 'old', undefined, 100)
        store.messages.markMessagesInvoked(session.id, ['old'], 100)
        const cutoff = store.messages.getAllMessages(session.id)[0]!.seq
        const oldId = store.messages.getAllMessages(session.id)[0]!.id
        const db = (store as unknown as { db: Database }).db
        const oldIndexRows = db.prepare('SELECT search_rowid FROM message_content_search_lookup WHERE target_message_id = ?').all(oldId) as Array<{ search_rowid: number }>
        expect(oldIndexRows.length).toBeGreaterThan(0)
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'keepword zx' } }, 'late', undefined, 100)
        store.messages.markMessagesInvoked(session.id, ['late'], 100)
        expect(store.messages.searchContent('pruneword', 'default')).toHaveLength(1)
        expect(store.messages.searchContent('qx', 'default')).toHaveLength(1)
        expect(store.messages.searchContent('keepword', 'default')).toHaveLength(1)

        store.messages.truncateMessagesFromLocalId(session.id, 'old', [], cutoff)

        expect(db.prepare('SELECT search_rowid FROM message_content_search_lookup WHERE target_message_id = ?').all(oldId)).toEqual([])
        for (const row of oldIndexRows) {
            expect(db.prepare('SELECT rowid FROM message_content_search WHERE rowid = ?').all(row.search_rowid)).toEqual([])
            expect(db.prepare('SELECT search_rowid FROM message_content_search_short WHERE search_rowid = ?').all(row.search_rowid)).toEqual([])
        }
        expect(store.messages.searchContent('pruneword', 'default')).toEqual([])
        expect(store.messages.searchContent('qx', 'default')).toEqual([])
        expect(store.messages.searchContent('keepword', 'default')).toHaveLength(1)
        expect(store.messages.searchContent('zx', 'default')).toHaveLength(1)
        expect(store.messages.getAllMessages(session.id).map(m => m.localId)).toEqual(['late'])
    })

    it('rolls back message deletion and its derived search cleanup together', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('rollback-search', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'rollbackword qx' } }, 'old', undefined, 100)
        store.messages.markMessagesInvoked(session.id, ['old'], 100)
        const cutoff = store.messages.getAllMessages(session.id)[0]!.seq
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'survivingword zx' } }, 'late', undefined, 100)
        store.messages.markMessagesInvoked(session.id, ['late'], 100)
        expect(() => store.runInTransaction(() => {
            store.messages.truncateMessagesFromLocalId(session.id, 'old', [], cutoff)
            throw new Error('force outer rewind rollback')
        })).toThrow('force outer rewind rollback')
        expect(store.messages.searchContent('rollbackword', 'default')).toHaveLength(1)
        expect(store.messages.searchContent('qx', 'default')).toHaveLength(1)
        expect(store.messages.searchContent('survivingword', 'default')).toHaveLength(1)
        expect(store.messages.searchContent('zx', 'default')).toHaveLength(1)
        expect(store.messages.getAllMessages(session.id).map(m => m.localId)).toEqual(['old', 'late'])
    })

    it('preserves post-cutoff rows even at the same transcript timestamp and rejects a late boundary', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('bounded', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, { role: 'user' }, 'old', undefined, 100)
        const cutoff = store.messages.getAllMessages(session.id)[0]!.seq
        store.messages.addMessage(session.id, { role: 'user' }, 'late', undefined, 100)
        expect(() => store.messages.truncateMessagesFromLocalId(session.id, 'late', [], cutoff)).toThrow('newer')
        expect(store.messages.getAllMessages(session.id)).toHaveLength(2)
        expect(store.messages.truncateMessagesFromLocalId(session.id, 'old', [], cutoff).deleted).toBe(1)
        expect(store.messages.getAllMessages(session.id).map(m => m.localId)).toEqual(['late'])
    })

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
