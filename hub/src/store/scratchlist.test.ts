import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from './index'

describe('ScratchlistStore deletion atomicity', () => {
    it('rolls back the row delete when position normalization fails', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'scratchlist-delete-atomicity',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default',
        )
        store.scratchlist.create(session.id, 'first', { entryId: 'first', position: 0 })
        store.scratchlist.create(session.id, 'second', { entryId: 'second', position: 1 })

        const db = (store as unknown as { db: Database }).db
        db.exec(`
            CREATE TRIGGER fail_scratchlist_normalization
            BEFORE UPDATE OF position ON session_scratchlist
            WHEN NEW.session_id = '${session.id}' AND NEW.position >= 0
            BEGIN
                SELECT RAISE(ABORT, 'forced scratchlist normalization failure');
            END;
        `)

        expect(() => store.scratchlist.delete(session.id, 'first'))
            .toThrow('forced scratchlist normalization failure')
        expect(store.scratchlist.list(session.id).map((entry) => ({
            id: entry.entryId,
            position: entry.position,
        }))).toEqual([
            { id: 'first', position: 0 },
            { id: 'second', position: 1 },
        ])

        store.close()
    })
})

it('keeps a merged scratchlist reorderable above the creation cap', () => {
    const store = new Store(':memory:')
    try {
        const createSession = (id: string) => store.sessions.getOrCreateSession(
            id, { path: '/tmp', host: 'localhost', flavor: 'codex' }, null, 'default',
        )
        const target = createSession('scratchlist-target')
        const source = createSession('scratchlist-source')
        for (let index = 0; index < 200; index++) {
            store.scratchlist.create(target.id, 'Draft', { entryId: `draft-${index}` })
        }
        store.scratchlist.create(source.id, 'Imported draft', { entryId: 'imported-draft' })
        expect(store.scratchlist.transfer(source.id, target.id)).toEqual({ moved: 1, collided: 0 })
        const order = store.scratchlist.list(target.id).map(entry => entry.entryId).reverse()
        expect(order).toHaveLength(201)
        expect(store.scratchlist.reorder(target.id, order)?.map(entry => entry.entryId)).toEqual(order)
    } finally { store.close() }
})
