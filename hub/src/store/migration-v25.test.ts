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

describe('schema migration v25 to v26', () => {
    it('adds scratchlist position to a current-main v25 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v25-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        // Start from the current schema, then remove only the v26 ordering
        // column and index to model a database produced by main at v25.
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
        expect(version.user_version).toBe(26)
        migrated.close()
    })
})
