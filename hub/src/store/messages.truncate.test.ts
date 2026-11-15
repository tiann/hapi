import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
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

describe('truncateOpenCodeRewind invocation position', () => {
    for (const cutoffFirst of [true, false]) {
        it(`removes the invocation suffix when ${cutoffFirst ? 'the boundary' : 'a later turn'} was inserted first`, () => {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession('ordered-rewind', { path: '/tmp' }, null, 'default')
            const at = Date.now() - 10_000
            const input = (localId: string, created: number, invoked: number) => {
                const message = store.messages.addMessage(session.id,
                    { role: 'user', content: { type: 'text', text: localId } }, localId, at + invoked, at + created)
                store.messages.markMessagesInvoked(session.id, [localId], at + invoked)
                return message
            }
            try {
                const first = input(cutoffFirst ? 'boundary' : 'later', 0, cutoffFirst ? 300 : 400)
                const prefix = input('prefix', 100, 100)
                const second = input(cutoffFirst ? 'later' : 'boundary', 200, cutoffFirst ? 400 : 300)
                const boundary = cutoffFirst ? first : second
                const beforeEpoch = store.messages.getMessageEpoch(session.id)
                expect(store.messages.truncateOpenCodeRewind(session.id, boundary.seq, boundary.id)).toBe(beforeEpoch + 1)
                expect(store.messages.getAllMessages(session.id).map(message => message.id)).toEqual([prefix.id])
                expect(store.messages.searchContentInSession('prefix', 'default', session.id).matches.map(match => match.messageId)).toEqual([prefix.id])
                expect(store.messages.searchContent('boundary', 'default')).toEqual([])
                expect(store.messages.searchContent('later', 'default')).toEqual([])
            } finally { store.close() }
        })
    }

    it('uses created_at for null invocation times and seq to break equal-position ties', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('rewind-ties', { path: '/tmp' }, null, 'default')
        const db = (store as unknown as { db: Database }).db
        const at = Date.now() - 10_000
        try {
            const add = (text: string) => store.messages.addMessage(session.id,
                { role: 'agent', content: { type: 'text', text } }, undefined, undefined, at)
            const prefix = add('tieprefix')
            const boundary = add('tieboundary')
            const suffix = add('tiesuffix')
            db.query('UPDATE messages SET invoked_at = NULL WHERE id IN (?, ?)').run(prefix.id, suffix.id)
            store.messages.truncateOpenCodeRewind(session.id, boundary.seq, boundary.id)
            expect(store.messages.getAllMessages(session.id).map(message => message.id)).toEqual([prefix.id])
        } finally { store.close() }
    })

    it('refuses a missing session boundary without deleting rows or bumping epoch', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('missing-rewind', { path: '/tmp' }, null, 'default')
        try {
            const first = store.messages.addMessage(session.id, { role: 'agent', content: 'keep' })
            const second = store.messages.addMessage(session.id, { role: 'agent', content: 'also keep' })
            const otherSession = store.sessions.getOrCreateSession('other-rewind', { path: '/tmp' }, null, 'other')
            const other = store.messages.addMessage(otherSession.id, { role: 'agent', content: 'other session' })
            const before = store.messages.getAllMessages(session.id)
            const epoch = store.messages.getMessageEpoch(session.id)
            for (const [seq, id] of [[999, first.id], [first.seq, second.id], [first.seq, other.id]] as const) {
                expect(() => store.messages.truncateOpenCodeRewind(session.id, seq, id)).toThrow('Rewind boundary not found')
            }
            expect(store.messages.getAllMessages(session.id)).toEqual(before)
            expect(store.messages.getMessageEpoch(session.id)).toBe(epoch)
        } finally { store.close() }
    })
})
