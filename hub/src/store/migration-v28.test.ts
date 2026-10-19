import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
    }
})

describe('schema migration v27 to v28', () => {
    it('skips the v28 ALTER when a partial legacy database has no sessions table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v28-partial-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const legacy = new Database(dbPath)
        legacy.exec(`
            CREATE TABLE messages (
                session_id TEXT,
                created_at INTEGER,
                seq INTEGER,
                local_id TEXT,
                invoked_at INTEGER,
                scheduled_at INTEGER,
                delivery_state TEXT
            );
            CREATE TABLE usage_events (
                session_id TEXT,
                source_key TEXT,
                source_seq INTEGER,
                created_at INTEGER,
                agent TEXT,
                model TEXT,
                kind TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_read_tokens INTEGER,
                cache_creation_tokens INTEGER,
                total_tokens INTEGER,
                last_input_tokens INTEGER,
                last_output_tokens INTEGER,
                last_cache_read_tokens INTEGER,
                last_cache_creation_tokens INTEGER
            );
            CREATE TABLE usage_scan_state (
                session_id TEXT,
                message_epoch INTEGER,
                last_seq INTEGER
            );
            PRAGMA user_version = 0;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            const columns = internalDb.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

            expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
                'todos_source_at',
                'todos_source_seq'
            ]))
            expect(version.user_version).toBe(28)
        } finally {
            migrated.close()
        }
    })

    it('adds the structured task source position columns to a V27 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v28-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        initial.sessions.getOrCreateSession('migration-v28-session', { path: '/tmp', host: 'h' }, null, 'default')
        initial.close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE sessions DROP COLUMN todos_source_seq;
            ALTER TABLE sessions DROP COLUMN todos_source_at;
            PRAGMA user_version = 27;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const columnStatement = internalDb.prepare('PRAGMA table_info(sessions)')
        const columns = columnStatement.all() as Array<{ name: string }>
        columnStatement.finalize()
        const versionStatement = internalDb.prepare('PRAGMA user_version')
        const version = versionStatement.get() as { user_version: number }
        versionStatement.finalize()
        const sourceStatement = internalDb.prepare(
            'SELECT todos_source_at, todos_source_seq FROM sessions LIMIT 1'
        )
        const source = sourceStatement.get() as { todos_source_at: number | null; todos_source_seq: number | null }
        sourceStatement.finalize()

        expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            'todos_source_at',
            'todos_source_seq'
        ]))
        expect(version.user_version).toBe(28)
        expect(source).toEqual({ todos_source_at: null, todos_source_seq: null })
        migrated.close()
    })
})
