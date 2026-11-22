import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v25 to v31', () => {
    it('adds scratchlist position to a current-main v25 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v25-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        // Start from the current schema, then remove v26+ indexes and the
        // ordering column to model a database produced by main at v25.
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_future_scheduled_queued;
            DROP INDEX idx_messages_immediate_queued;
            DROP INDEX idx_session_scratchlist_session_position;
            ALTER TABLE session_scratchlist DROP COLUMN position;
            INSERT INTO session_scratchlist
                (session_id, entry_id, text, created_at, updated_at, attachments)
            VALUES
                ('session-1', 'older', 'older', 100, 100, NULL),
                ('session-1', 'newer', 'newer', 200, 200, NULL);
            PRAGMA user_version = 25;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        expect(migrated.scratchlist.list('session-1').map((entry) => ({
            entryId: entry.entryId,
            position: entry.position,
        }))).toEqual([
            { entryId: 'newer', position: 0 },
            { entryId: 'older', position: 1 },
        ])

        const internalDb = (migrated as unknown as { db: Database }).db
        const columns = internalDb.prepare('PRAGMA table_info(session_scratchlist)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(columns.some((column) => column.name === 'position')).toBe(true)
        expect(version.user_version).toBe(37)
        migrated.close()
    })

    it('upgrades an existing v26 database with scratchlist rows', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_future_scheduled_queued;
            DROP INDEX idx_session_scratchlist_session_position;
            ALTER TABLE session_scratchlist DROP COLUMN position;
            INSERT INTO session_scratchlist
                (session_id, entry_id, text, created_at, updated_at, attachments)
            VALUES
                ('session-1', 'older', 'older', 100, 100, NULL),
                ('session-1', 'newer', 'newer', 200, 200, NULL);
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        expect(migrated.scratchlist.list('session-1').map((entry) => ({
            entryId: entry.entryId,
            position: entry.position,
        }))).toEqual([
            { entryId: 'newer', position: 0 },
            { entryId: 'older', position: 1 },
        ])

        const internalDb = (migrated as unknown as { db: Database }).db
        const columns = internalDb.prepare('PRAGMA table_info(session_scratchlist)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const positionIndex = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_scratchlist_session_position'"
        ).get() as { name: string } | null
        expect(columns.some((column) => column.name === 'position')).toBe(true)
        expect(positionIndex?.name).toBe('idx_session_scratchlist_session_position')
        expect(version.user_version).toBe(37)
        migrated.close()
    })

    it('upgrades an existing v29 database without scratchlist ordering', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v29-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_session_scratchlist_session_position;
            ALTER TABLE session_scratchlist DROP COLUMN position;
            INSERT INTO session_scratchlist
                (session_id, entry_id, text, created_at, updated_at, attachments)
            VALUES
                ('session-1', 'older', 'older', 100, 100, NULL),
                ('session-1', 'newer', 'newer', 200, 200, NULL);
            PRAGMA user_version = 29;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        expect(migrated.scratchlist.list('session-1').map((entry) => ({
            entryId: entry.entryId,
            position: entry.position,
        }))).toEqual([
            { entryId: 'newer', position: 0 },
            { entryId: 'older', position: 1 },
        ])

        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const columns = internalDb.prepare('PRAGMA table_info(session_scratchlist)').all() as Array<{ name: string }>
        const positionIndex = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_scratchlist_session_position'"
        ).get() as { name: string } | null
        expect(columns.some((column) => column.name === 'position')).toBe(true)
        expect(positionIndex?.name).toBe('idx_session_scratchlist_session_position')
        expect(version.user_version).toBe(37)
        migrated.close()
    })

    it('upgrades the upstream v36 passkey schema without losing credentials or draft order', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-scratchlist-v36-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        try {
            legacy.exec(`
                DROP INDEX idx_session_scratchlist_session_position;
                ALTER TABLE session_scratchlist DROP COLUMN position;
                INSERT INTO passkey_credentials (id, namespace, rp_id, public_key, token_fingerprint, created_at)
                    VALUES ('fixture-key', 'default', 'example.test', x'01', 'fixture', 1);
                INSERT INTO session_scratchlist (session_id, entry_id, text, created_at, updated_at, attachments)
                    VALUES ('s1','older','older',1,1,NULL), ('s1','newer','newer',2,2,NULL);
                PRAGMA user_version = 36;
            `)
        } finally { legacy.close() }
        const migrated = new Store(dbPath)
        try {
            const internal = (migrated as unknown as { db: Database }).db
            expect(internal.prepare('PRAGMA user_version').get()).toEqual({ user_version: 37 })
            expect(internal.prepare('SELECT id FROM passkey_credentials').all()).toEqual([{ id: 'fixture-key' }])
            expect(migrated.scratchlist.list('s1').map(entry => [entry.entryId, entry.position])).toEqual([['newer', 0], ['older', 1]])
        } finally { migrated.close() }
    })

    it('adds an index used by immediate queued-message replay', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v25-index-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_immediate_queued;
            PRAGMA user_version = 25;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const plan = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT * FROM messages
            WHERE session_id = ?
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND scheduled_at IS NULL
              AND delivery_state = 'queued'
            ORDER BY seq ASC
        `).all('session-id') as Array<{ detail: string }>

        expect(version.user_version).toBe(37)
        expect(plan.some((row) => row.detail.includes('idx_messages_immediate_queued'))).toBe(true)
        migrated.close()
    })
})
