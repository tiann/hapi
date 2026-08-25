import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store V18->V19 migration: usage scan state', () => {
    it('adds the usage_scan_state table to a V18 database', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v18-to-v19-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            store.close()
            store = undefined

            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                INSERT INTO sessions (id, created_at, updated_at)
                VALUES ('session-1', 1, 1);
                INSERT INTO usage_events (
                    session_id, source_key, source_seq, created_at, agent, kind
                ) VALUES (
                    'session-1', 'old-cumulative-key', 1, 1, 'codex', 'cumulative'
                );
                DROP TABLE usage_scan_state;
                PRAGMA user_version = 18;
            `)
            db.close()

            store = new Store(dbPath)
            const internalDb = (store as unknown as { db: Database }).db
            const table = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_scan_state'"
            ).get() as { name: string } | null
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            const usageRows = internalDb.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }

            expect(table?.name).toBe('usage_scan_state')
            expect(version.user_version).toBe(25)
            expect(usageRows.count).toBe(0)
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
