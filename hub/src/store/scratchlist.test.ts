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
