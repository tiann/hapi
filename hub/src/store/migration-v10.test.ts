import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V9→V10 schema migration: introduces the `session_scratchlist`
 * typed table for tiann/hapi#893 (scratchlist v2 hub sync). Mirrors the
 * pattern in `migration-v9.test.ts`.
 *
 * The new table is independent (no backfill from existing rows) so the
 * tests focus on:
 *   - presence on fresh DBs
 *   - presence on multi-hop legacy DBs (V6/V7/V8/V9 → V10)
 *   - idempotency on reopen
 *   - foreign-key cascade-delete from sessions(id)
 *   - the supporting (session_id, created_at) index
 *   - basic CRUD operations through the ScratchlistStore wrapper
 */
describe('Store V9→V10 migration: session_scratchlist table', () => {
    it('fresh DB has session_scratchlist table with expected columns', () => {
        const store = new Store(':memory:')
        const cols = getColumns(store, 'session_scratchlist')
        expect(cols).toContain('session_id')
        expect(cols).toContain('entry_id')
        expect(cols).toContain('text')
        expect(cols).toContain('created_at')
        expect(cols).toContain('updated_at')
    })

    it('fresh DB has the (session_id, created_at) index', () => {
        const store = new Store(':memory:')
        const db: Database = (store as unknown as { db: Database }).db
        const rows = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_scratchlist_session_created'"
        ).all() as Array<{ name: string }>
        expect(rows).toHaveLength(1)
    })

    it('V9 DB migrates to V10 via Store: session_scratchlist created', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v10-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV9Schema(db)
            db.exec('PRAGMA user_version = 9')
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                     VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.close()

            store = new Store(dbPath)
            const cols = getColumns(store, 'session_scratchlist')
            expect(cols).toContain('session_id')
            expect(cols).toContain('text')

            // Existing session row remains intact through the migration.
            const sessions = (store as unknown as { db: Database }).db.prepare(
                'SELECT id FROM sessions'
            ).all() as Array<{ id: string }>
            expect(sessions.map((r) => r.id)).toEqual(['s1'])
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V8 DB migrates to V10 (multi-hop V8→V9→V10)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v8-to-v10-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV9Schema(db) // V9 is a superset of V8's tables for our purposes
            db.exec('PRAGMA user_version = 8')
            db.close()

            store = new Store(dbPath)
            // After ladder runs, both v8→v9 (scheduled_at) AND v9→v10 (table) applied.
            const messageCols = getColumns(store, 'messages')
            expect(messageCols).toContain('scheduled_at')
            const scratchCols = getColumns(store, 'session_scratchlist')
            expect(scratchCols).toContain('entry_id')
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V10 DB reopen is idempotent: schema unchanged', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v10-idempotent-'))
        const dbPath = join(dir, 'test.db')
        let store1: Store | undefined
        let store2: Store | undefined
        try {
            store1 = new Store(dbPath)
            const cols1 = getColumns(store1, 'session_scratchlist')

            store2 = new Store(dbPath)
            const cols2 = getColumns(store2, 'session_scratchlist')
            expect(cols2).toEqual(cols1)
        } finally {
            store2?.close()
            store1?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('cascade-delete: scratchlist entries are removed when their session is deleted', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const create1 = store.scratchlist.create(session.id, 'note one')
        const create2 = store.scratchlist.create(session.id, 'note two')
        expect(create1.outcome).toBe('created')
        expect(create2.outcome).toBe('created')
        expect(store.scratchlist.count(session.id)).toBe(2)

        await store.sessions.deleteSession(session.id, 'default')
        expect(store.scratchlist.count(session.id)).toBe(0)
    })
})

describe('ScratchlistStore: CRUD through the typed-table wrapper', () => {
    function setup() {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        return { store, sessionId: session.id }
    }

    it('create returns the canonical row and assigns an entryId when omitted', () => {
        const { store, sessionId } = setup()
        const result = store.scratchlist.create(sessionId, 'hello')
        if (result.outcome !== 'created') {
            throw new Error(`Expected created, got ${result.outcome}`)
        }
        expect(result.entry.text).toBe('hello')
        expect(result.entry.entryId).toMatch(/[0-9a-f-]{8,}/)
        expect(result.entry.createdAt).toBeGreaterThan(0)
        expect(result.entry.updatedAt).toBe(result.entry.createdAt)
    })

    it('create preserves caller-supplied entryId and createdAt for migration path', () => {
        const { store, sessionId } = setup()
        const result = store.scratchlist.create(sessionId, 'migrated', {
            entryId: 'legacy-id-1',
            createdAt: 12345,
        })
        if (result.outcome !== 'created') throw new Error(`Expected created, got ${result.outcome}`)
        expect(result.entry.entryId).toBe('legacy-id-1')
        expect(result.entry.createdAt).toBe(12345)
        // updatedAt is always Date.now() on insert; differs from createdAt when caller supplies an old timestamp.
        expect(result.entry.updatedAt).toBeGreaterThan(12345)
    })

    it('create with an existing entryId is reported as duplicate and returns the existing row', () => {
        const { store, sessionId } = setup()
        const first = store.scratchlist.create(sessionId, 'first', { entryId: 'dup-id' })
        if (first.outcome !== 'created') throw new Error(`Expected created`)
        const second = store.scratchlist.create(sessionId, 'second', { entryId: 'dup-id' })
        if (second.outcome !== 'duplicate') {
            throw new Error(`Expected duplicate, got ${second.outcome}`)
        }
        expect(second.entry.text).toBe('first')
    })

    it('create against a non-existent session reports session-not-found (not a SQLite error)', () => {
        const store = new Store(':memory:')
        const result = store.scratchlist.create('does-not-exist', 'orphan')
        expect(result.outcome).toBe('session-not-found')
    })

    it('list returns entries in createdAt DESC order (newest first)', () => {
        const { store, sessionId } = setup()
        const a = store.scratchlist.create(sessionId, 'oldest', { entryId: 'a', createdAt: 1000 })
        const b = store.scratchlist.create(sessionId, 'middle', { entryId: 'b', createdAt: 2000 })
        const c = store.scratchlist.create(sessionId, 'newest', { entryId: 'c', createdAt: 3000 })
        expect(a.outcome).toBe('created')
        expect(b.outcome).toBe('created')
        expect(c.outcome).toBe('created')
        const entries = store.scratchlist.list(sessionId)
        expect(entries.map((e) => e.entryId)).toEqual(['c', 'b', 'a'])
    })

    it('update bumps updated_at without touching createdAt; returns null for missing entries', () => {
        const { store, sessionId } = setup()
        const created = store.scratchlist.create(sessionId, 'before', {
            entryId: 'u1',
            createdAt: 1000,
        })
        if (created.outcome !== 'created') throw new Error('Expected created')

        const updated = store.scratchlist.update(sessionId, 'u1', 'after')
        expect(updated).not.toBeNull()
        expect(updated!.text).toBe('after')
        expect(updated!.createdAt).toBe(1000)
        expect(updated!.updatedAt).toBeGreaterThan(1000)

        const missing = store.scratchlist.update(sessionId, 'does-not-exist', 'noop')
        expect(missing).toBeNull()
    })

    it('delete returns true when the row existed, false otherwise', () => {
        const { store, sessionId } = setup()
        store.scratchlist.create(sessionId, 'doomed', { entryId: 'd1' })
        expect(store.scratchlist.delete(sessionId, 'd1')).toBe(true)
        expect(store.scratchlist.delete(sessionId, 'd1')).toBe(false)
    })

    it('count tracks current rows', () => {
        const { store, sessionId } = setup()
        expect(store.scratchlist.count(sessionId)).toBe(0)
        store.scratchlist.create(sessionId, 'a', { entryId: 'a' })
        store.scratchlist.create(sessionId, 'b', { entryId: 'b' })
        expect(store.scratchlist.count(sessionId)).toBe(2)
        store.scratchlist.delete(sessionId, 'a')
        expect(store.scratchlist.count(sessionId)).toBe(1)
    })

    it('entries from session A are not visible to session B', () => {
        const store = new Store(':memory:')
        const a = store.sessions.getOrCreateSession('a', { path: '/a' }, null, 'default')
        const b = store.sessions.getOrCreateSession('b', { path: '/b' }, null, 'default')
        store.scratchlist.create(a.id, 'A note', { entryId: 'shared-id' })
        expect(store.scratchlist.list(b.id)).toEqual([])
        expect(store.scratchlist.get(a.id, 'shared-id')).not.toBeNull()
        expect(store.scratchlist.get(b.id, 'shared-id')).toBeNull()
    })
})

function getColumns(store: Store, table: string): string[] {
    const db: Database = (store as unknown as { db: Database }).db
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.map((r) => r.name)
}

/**
 * V9 schema: full pre-V10 shape. Used to seed legacy DBs to verify the
 * V9→V10 step adds the new table without disturbing existing rows.
 */
function createV9Schema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            tag TEXT,
            namespace TEXT NOT NULL DEFAULT 'default',
            machine_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            agent_state TEXT,
            agent_state_version INTEGER DEFAULT 1,
            model TEXT,
            model_reasoning_effort TEXT,
            effort TEXT,
            todos TEXT,
            todos_updated_at INTEGER,
            team_state TEXT,
            team_state_updated_at INTEGER,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
        CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

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
        CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

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
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_session_position
            ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_scheduled_pending
            ON messages(scheduled_at)
            WHERE scheduled_at IS NOT NULL AND invoked_at IS NULL;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
        CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);
    `)
}
