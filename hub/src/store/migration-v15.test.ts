import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V14→V15 schema migration: adds `session_scratchlist.attachments`
 * for tiann/hapi#921 (scratchlist v2.2 hub attachment storage).
 *
 * Ladder: V11→V12 = session_scratchlist (#896), V12–V14 = message_epochs
 * reconciliation, V14→V15 = attachments column (#921).
 */
describe('Store V14→V15 migration: scratchlist attachments column', () => {
    it('fresh DB has session_scratchlist.attachments', () => {
        const store = new Store(':memory:')
        const cols = getColumns(store, 'session_scratchlist')
        expect(cols).toContain('attachments')
        expect(getColumns(store, 'usage_events')).toContain('last_input_tokens')
        expect(getColumns(store, 'usage_scan_state')).toContain('last_seq')
        expect(getUserVersion(store)).toBe(25)
        store.close()
    })

    it('V14 text-only scratchlist migrates to V15 and gains attachments column', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v14-to-v15-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV14Schema(db)
            db.exec('PRAGMA user_version = 14')
            db.close()

            store = new Store(dbPath)
            const cols = getColumns(store, 'session_scratchlist')
            expect(cols).toContain('attachments')
            expect(getColumns(store, 'usage_events')).toContain('last_input_tokens')
            expect(getColumns(store, 'usage_scan_state')).toContain('last_seq')
            expect(getUserVersion(store)).toBe(25)
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('latest DB reopen is idempotent: schema unchanged', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v15-idempotent-'))
        const dbPath = join(dir, 'test.db')
        let store1: Store | undefined
        let store2: Store | undefined
        try {
            store1 = new Store(dbPath)
            const cols1 = getColumns(store1, 'session_scratchlist')
            expect(cols1).toContain('attachments')

            store2 = new Store(dbPath)
            const cols2 = getColumns(store2, 'session_scratchlist')
            expect(cols2).toEqual(cols1)
            expect(getUserVersion(store2)).toBe(25)
        } finally {
            store2?.close()
            store1?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

function getColumns(store: Store, table: string): string[] {
    const db: Database = (store as unknown as { db: Database }).db
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.map((r) => r.name)
}

function getUserVersion(store: Store): number {
    const db: Database = (store as unknown as { db: Database }).db
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    return row.user_version
}

/** Post-V13→V14 shape: scratchlist + message_epochs, no attachments column yet. */
function createV14Schema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            tag TEXT,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            agent_state TEXT,
            agent_state_version INTEGER DEFAULT 1,
            data_encryption_key BLOB,
            thinking INTEGER DEFAULT 0,
            thinking_updated_at INTEGER,
            todos TEXT,
            todos_updated_at INTEGER,
            team_state TEXT,
            team_state_updated_at INTEGER,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0,
            service_tier TEXT
        );

        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            runner_state TEXT,
            runner_state_version INTEGER DEFAULT 1,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT,
            invoked_at INTEGER,
            scheduled_at INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS message_epochs (
            session_id TEXT PRIMARY KEY,
            epoch INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );

        CREATE TABLE IF NOT EXISTS fcm_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            token TEXT NOT NULL,
            platform TEXT NOT NULL,
            device_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(namespace, device_id, platform)
        );

        CREATE TABLE IF NOT EXISTS session_scratchlist (
            session_id TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, entry_id),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_scratchlist_session_created
            ON session_scratchlist(session_id, created_at DESC);
    `)
}
