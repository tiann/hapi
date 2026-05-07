import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V8→V9 schema migration: adding scheduled_at column to messages table.
 * Follows the same pattern as migration-v8.test.ts.
 */
describe('Store V8→V9 migration: scheduled_at column', () => {
    it('fresh DB has scheduled_at column in messages', () => {
        const store = new Store(':memory:')
        const cols = getMessageColumns(store)
        expect(cols).toContain('scheduled_at')
    })

    it('V8 DB migrates to V9 via Store: scheduled_at added, existing rows have NULL scheduled_at', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-test-'))
        const dbPath = join(dir, 'test.db')
        try {
            // Build a V8 DB on disk, insert rows, then open via Store to trigger migration
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            db.exec('PRAGMA user_version = 8')
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                     VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at)
                     VALUES ('m1', 's1', '"hello"', 1000, 1, 'l1', NULL)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at)
                     VALUES ('m2', 's1', '"world"', 2000, 2, NULL, 2000)`)
            db.close()

            // Open via Store — should auto-migrate V8→V9
            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            expect(cols).toContain('scheduled_at')

            // Existing rows should have scheduled_at = NULL
            const msgs = store.messages.getMessages('s1')
            expect(msgs).toHaveLength(2)
            const m1 = msgs.find(m => m.id === 'm1')!
            const m2 = msgs.find(m => m.id === 'm2')!
            expect(m1.scheduledAt).toBeNull()
            expect(m2.scheduledAt).toBeNull()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V7 DB migrates to V9 (multi-hop: V7→V8→V9)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v7-to-v9-'))
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
            expect(cols).toContain('invoked_at')
            expect(cols).toContain('scheduled_at')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V6 DB migrates to V9 (multi-hop)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v6-to-v9-'))
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
            expect(cols).toContain('scheduled_at')
            const sessionCols = getSessionColumns(store)
            expect(sessionCols).toContain('model_reasoning_effort')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V9 DB reopen is idempotent: schema unchanged', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-idempotent-'))
        const dbPath = join(dir, 'test.db')
        try {
            const store1 = new Store(dbPath)
            const cols1 = getMessageColumns(store1)
            expect(cols1).toContain('scheduled_at')

            // Re-open same DB — version is already 9, must not throw or alter schema
            const store2 = new Store(dbPath)
            const cols2 = getMessageColumns(store2)
            expect(cols2).toEqual(cols1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('migrateFromV8ToV9 PRAGMA guard: scheduled_at column appears exactly once', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-guard-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            db.exec('PRAGMA user_version = 8')
            db.close()

            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            const count = cols.filter(c => c === 'scheduled_at').length
            expect(count).toBe(1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('idx_messages_scheduled_pending index exists on fresh DB', () => {
        const store = new Store(':memory:')
        const db: Database = (store as any).db
        const rows = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_scheduled_pending'"
        ).all() as Array<{ name: string }>
        expect(rows).toHaveLength(1)
    })

    it('idx_messages_scheduled_pending index exists after V8→V9 migration', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-index-v8-v9-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            db.exec('PRAGMA user_version = 8')
            db.close()

            const store = new Store(dbPath)
            const db2: Database = (store as any).db
            const rows = db2.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_scheduled_pending'"
            ).all() as Array<{ name: string }>
            expect(rows).toHaveLength(1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('Store V9: scheduled_at store operations', () => {
    it('addMessage with scheduledAt stores the value', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const futureMs = Date.now() + 60_000
        const msg = store.messages.addMessage(session.id, 'hello', 'local-1', futureMs)
        expect(msg.scheduledAt).toBe(futureMs)
    })

    it('addMessage without scheduledAt has scheduledAt = null', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const msg = store.messages.addMessage(session.id, 'hello', 'local-1')
        expect(msg.scheduledAt).toBeNull()
    })

    it('getMatureScheduledMessages returns messages with scheduled_at <= now', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const now = Date.now()
        const past = now - 1000
        const future = now + 60_000

        // Mature: scheduled_at in the past
        const mature = store.messages.addMessage(session.id, 'mature', 'local-mature', past)
        // Future: not yet mature
        store.messages.addMessage(session.id, 'future', 'local-future', future)
        // No scheduledAt: not scheduled
        store.messages.addMessage(session.id, 'plain', 'local-plain')

        const results = store.messages.getMatureScheduledMessages(now)
        expect(results.map(m => m.id)).toContain(mature.id)
        expect(results).toHaveLength(1)
    })

    it('getMatureScheduledMessages excludes already-invoked messages', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const now = Date.now()
        const past = now - 1000

        const msg = store.messages.addMessage(session.id, 'mature', 'local-m', past)
        // Simulate CLI ack
        store.messages.markMessagesInvoked(session.id, ['local-m'], now)

        const results = store.messages.getMatureScheduledMessages(now)
        expect(results.find(m => m.id === msg.id)).toBeUndefined()
    })

    it('getMatureScheduledMessages returns in scheduled_at ASC order', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const now = Date.now()

        const msg2 = store.messages.addMessage(session.id, 'second', 'local-2', now - 500)
        const msg1 = store.messages.addMessage(session.id, 'first', 'local-1', now - 1000)

        const results = store.messages.getMatureScheduledMessages(now)
        expect(results.map(m => m.id)).toEqual([msg1.id, msg2.id])
    })

    it('getImmediateQueuedLocalMessages: returns only immediate queued, excludes mature AND future scheduled (HAPI Bot R4)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const now = Date.now()

        // Immediate queued (no scheduledAt) — included
        const immediate = store.messages.addMessage(session.id, 'immediate', 'local-imm')
        // Mature scheduled — must be excluded so the mature-scan path can deliver it
        // with the no-stamp + re-emit-until-ack contract.
        store.messages.addMessage(session.id, 'mature', 'local-mature', now - 1000)
        // Future scheduled — must be excluded
        store.messages.addMessage(session.id, 'future', 'local-future', now + 60_000)

        const results = store.messages.getImmediateQueuedLocalMessages(session.id)
        const ids = results.map(m => m.id)
        expect(ids).toEqual([immediate.id])
    })

    it('getImmediateQueuedLocalMessages excludes already-invoked messages', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const now = Date.now()

        const msg = store.messages.addMessage(session.id, 'q', 'local-q')
        store.messages.markMessagesInvoked(session.id, ['local-q'], now)

        const results = store.messages.getImmediateQueuedLocalMessages(session.id)
        expect(results.find(m => m.id === msg.id)).toBeUndefined()
    })

    it('getUninvokedLocalMessages still includes future scheduled (for Web bar display)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const future = Date.now() + 60_000

        const scheduled = store.messages.addMessage(session.id, 'future', 'local-f', future)

        const results = store.messages.getUninvokedLocalMessages(session.id)
        expect(results.map(m => m.id)).toContain(scheduled.id)
    })

    it('legacy DB (user_version=0 with V8-shape tables): step ladder backfills scheduled_at', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-legacy-v0-v9-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            // Intentionally do NOT set user_version — leaves it at 0 (legacy)
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                     VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at)
                     VALUES ('m1', 's1', '"hi"', 1500, 1, 'l1', NULL)`)
            db.close()

            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            expect(cols).toContain('scheduled_at')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

function getMessageColumns(store: Store): string[] {
    const db: Database = (store as any).db
    const rows = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    return rows.map(r => r.name)
}

function getSessionColumns(store: Store): string[] {
    const db: Database = (store as any).db
    const rows = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    return rows.map(r => r.name)
}

/** V8 schema: messages table with invoked_at but without scheduled_at */
function createV8Schema(db: Database): void {
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
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_session_position
            ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);

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

/** V7 schema: messages table without invoked_at (and thus without scheduled_at) */
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
