import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V7→V8 schema migration: adding invoked_at column to messages table.
 * All migration tests open a real Store to exercise the actual migration code path.
 */
describe('Store V7→V8 migration: invoked_at column', () => {
    it('fresh DB has invoked_at column in messages', () => {
        const store = new Store(':memory:')
        const cols = getMessageColumns(store)
        expect(cols).toContain('invoked_at')
    })

    it('V7 DB migrates to V8 via Store: invoked_at added, existing rows backfilled to created_at', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v8-test-'))
        const dbPath = join(dir, 'test.db')
        try {
            // Build a V7 DB on disk, insert rows, then open via Store to trigger migration
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV7Schema(db)
            db.exec('PRAGMA user_version = 7')
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                     VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq)
                     VALUES ('m1', 's1', '"hello"', 1000, 1)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq)
                     VALUES ('m2', 's1', '"world"', 2000, 2)`)
            db.close()

            // Open via Store — should auto-migrate V7→V8
            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            expect(cols).toContain('invoked_at')

            // Backfill: existing rows must have invoked_at == created_at (not NULL)
            const msgs = store.messages.getMessages('s1')
            expect(msgs).toHaveLength(2)
            const m1 = msgs.find(m => m.id === 'm1')!
            const m2 = msgs.find(m => m.id === 'm2')!
            expect(m1.invokedAt).toBe(1000)
            expect(m2.invokedAt).toBe(2000)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V6 DB migrates to V8 (multi-hop)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v6-test-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV6Schema(db)
            db.exec('PRAGMA user_version = 6')
            db.close()

            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            expect(cols).toContain('invoked_at')
            // sessions table should have model_reasoning_effort (added in V6→V7)
            const sessionCols = getSessionColumns(store)
            expect(sessionCols).toContain('model_reasoning_effort')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V5 DB migrates to V8 (multi-hop)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v5-test-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV5Schema(db)
            db.exec('PRAGMA user_version = 5')
            db.close()

            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            expect(cols).toContain('invoked_at')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V4 DB migrates to V8 (multi-hop)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v4-test-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV4Schema(db)
            db.exec('PRAGMA user_version = 4')
            db.close()

            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            expect(cols).toContain('invoked_at')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V8 DB reopen is idempotent: schema unchanged', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v8-idempotent-'))
        const dbPath = join(dir, 'test.db')
        try {
            const store1 = new Store(dbPath)
            const cols1 = getMessageColumns(store1)
            expect(cols1).toContain('invoked_at')

            // Re-open same DB — version is already 8, must not throw or alter schema
            const store2 = new Store(dbPath)
            const cols2 = getMessageColumns(store2)
            expect(cols2).toEqual(cols1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('migrateFromV7ToV8 PRAGMA guard: invoked_at column appears exactly once', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v8-guard-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV7Schema(db)
            db.exec('PRAGMA user_version = 7')
            db.close()

            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            const count = cols.filter(c => c === 'invoked_at').length
            expect(count).toBe(1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('markMessagesInvoked sets invoked_at on matching messages', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const msg1 = store.messages.addMessage(session.id, 'hello', 'local-1')
        const msg2 = store.messages.addMessage(session.id, 'world', 'local-2')

        // Initially both have invokedAt = null (new messages added to fresh V8 DB)
        expect(store.messages.getMessages(session.id).map(m => m.invokedAt)).toEqual([null, null])

        const ts = Date.now()
        store.messages.markMessagesInvoked(session.id, ['local-1'], ts)

        const msgs = store.messages.getMessages(session.id)
        const m1 = msgs.find(m => m.id === msg1.id)!
        const m2 = msgs.find(m => m.id === msg2.id)!
        expect(m1.invokedAt).toBe(ts)
        expect(m2.invokedAt).toBeNull()
    })

    it('markMessagesInvoked is idempotent (repeated call updates timestamp)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, 'hi', 'local-x')

        const ts1 = 1000
        const ts2 = 2000
        store.messages.markMessagesInvoked(session.id, ['local-x'], ts1)
        // calling again with different ts should overwrite (UPDATE is idempotent-safe)
        store.messages.markMessagesInvoked(session.id, ['local-x'], ts2)

        const msgs = store.messages.getMessages(session.id)
        expect(msgs[0].invokedAt).toBe(ts2)
    })

    it('addMessage sets invoked_at to NULL by default', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const msg = store.messages.addMessage(session.id, 'content')
        expect(msg.invokedAt).toBeNull()
    })
})

function getMessageColumns(store: Store): string[] {
    // Access internal db via reflection — safe for test only
    const db: Database = (store as any).db
    const rows = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    return rows.map(r => r.name)
}

function getSessionColumns(store: Store): string[] {
    const db: Database = (store as any).db
    const rows = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    return rows.map(r => r.name)
}

/** V7 schema: messages table without invoked_at */
function createV7Schema(db: Database): void {
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
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

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

/** V6 schema: sessions without model_reasoning_effort; messages without invoked_at */
function createV6Schema(db: Database): void {
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
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

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

/** V5 schema: sessions without effort, model_reasoning_effort; messages without invoked_at */
function createV5Schema(db: Database): void {
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
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

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

/** V4 schema: sessions without model, effort, model_reasoning_effort; messages without invoked_at */
function createV4Schema(db: Database): void {
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
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

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
