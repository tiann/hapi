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

    it('markMessagesInvoked is first-write-wins (subsequent calls are no-ops)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, 'hi', 'local-x')

        const ts1 = 1000
        const ts2 = 2000
        store.messages.markMessagesInvoked(session.id, ['local-x'], ts1)
        // A duplicate ack (CLI re-emit) must not overwrite the original timestamp:
        // re-stamping invoked_at would shuffle the message in the byPosition-ordered
        // thread for every subscribed client.
        store.messages.markMessagesInvoked(session.id, ['local-x'], ts2)

        const msgs = store.messages.getMessages(session.id)
        expect(msgs[0].invokedAt).toBe(ts1)
    })

    it('addMessage with localId leaves invoked_at NULL (ack path is messages-consumed)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const msg = store.messages.addMessage(session.id, 'content', 'local-1')
        expect(msg.invokedAt).toBeNull()
    })

    it('addMessage without localId sets invoked_at = created_at (no ack path)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const msg = store.messages.addMessage(session.id, 'content')
        expect(msg.invokedAt).toBe(msg.createdAt)
    })

    it('getUninvokedLocalMessages returns rows with localId and null invoked_at', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const queued = store.messages.addMessage(session.id, 'q', 'local-q')
        store.messages.addMessage(session.id, 'no-localid')          // invoked_at = createdAt, excluded
        store.messages.addMessage(session.id, 'invoked', 'local-i')
        store.messages.markMessagesInvoked(session.id, ['local-i'], Date.now())

        const uninvoked = store.messages.getUninvokedLocalMessages(session.id)
        expect(uninvoked.map(m => m.id)).toEqual([queued.id])
    })

    it('getUninvokedLocalMessages returns empty for session with no queued messages', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, 'plain')                                // invoked_at set
        const sent = store.messages.addMessage(session.id, 'sent', 'local-s')
        store.messages.markMessagesInvoked(session.id, ['local-s'], Date.now())
        expect(sent.invokedAt).toBeNull()  // value at insert; row has been updated since
        expect(store.messages.getUninvokedLocalMessages(session.id)).toEqual([])
    })

    // Mirrors the session-end handler's auto-invoke contract at the store
    // layer: when a CLI exits, we sweep every queued message for the session
    // (getUninvokedLocalMessages) and stamp them with a single timestamp
    // (markMessagesInvoked). After the sweep, no queued ghosts may remain —
    // otherwise the floating bar would survive across reloads even though the
    // CLI is no longer running.
    it('session-end pattern: getUninvokedLocalMessages + markMessagesInvoked clears all queued', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, 'q1', 'local-1')
        store.messages.addMessage(session.id, 'q2', 'local-2')
        store.messages.addMessage(session.id, 'q3', 'local-3')

        const queuedBefore = store.messages.getUninvokedLocalMessages(session.id)
        expect(queuedBefore).toHaveLength(3)
        const localIds = queuedBefore
            .map(m => m.localId)
            .filter((id): id is string => id !== null)
        expect(localIds).toHaveLength(3)

        const ts = Date.now()
        store.messages.markMessagesInvoked(session.id, localIds, ts)

        const queuedAfter = store.messages.getUninvokedLocalMessages(session.id)
        expect(queuedAfter).toHaveLength(0)
        // And every row now carries the same invokedAt — a partial sweep would
        // leave the floating bar half-cleared on the web client.
        const allMessages = store.messages.getMessages(session.id)
        for (const msg of allMessages) {
            expect(msg.invokedAt).toBe(ts)
        }
    })
})

describe('Store V8 byPosition pagination', () => {
    it('getMessagesByPosition returns messages in ascending order', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const msg1 = store.messages.addMessage(session.id, 'a', 'loc-1')
        const msg2 = store.messages.addMessage(session.id, 'b', 'loc-2')
        const msg3 = store.messages.addMessage(session.id, 'c', 'loc-3')
        // All start with null invokedAt; set different invokedAt values
        store.messages.markMessagesInvoked(session.id, ['loc-1'], 1000)
        store.messages.markMessagesInvoked(session.id, ['loc-2'], 2000)
        store.messages.markMessagesInvoked(session.id, ['loc-3'], 3000)

        const result = store.messages.getMessagesByPosition(session.id, 50)
        expect(result.map(m => m.id)).toEqual([msg1.id, msg2.id, msg3.id])
    })

    it('getMessagesByPosition sorts by invokedAt DESC, seq DESC (latest first, reversed to ascending)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        // Insert 3 messages: msg1 has low seq but high invokedAt (queued message that was consumed late)
        const msg1 = store.messages.addMessage(session.id, 'queued', 'loc-q')
        const msg2 = store.messages.addMessage(session.id, 'normal-1')  // no localId → invokedAt = createdAt
        const msg3 = store.messages.addMessage(session.id, 'normal-2')  // no localId → invokedAt = createdAt

        // Simulate: msg1 (seq=1) is invoked much later than msg2 and msg3
        store.messages.markMessagesInvoked(session.id, ['loc-q'], msg3.createdAt + 10_000)

        const result = store.messages.getMessagesByPosition(session.id, 50)
        // Expected order by position_at ASC: msg2, msg3, msg1 (msg1 has highest invokedAt)
        expect(result[result.length - 1].id).toBe(msg1.id)
        expect(result[0].id).toBe(msg2.id)
    })

    it('getMessagesByPosition composite cursor: second page has no gap or duplicate', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        // Add 5 messages with distinct invokedAt timestamps
        const messages = []
        for (let i = 0; i < 5; i++) {
            const msg = store.messages.addMessage(session.id, `msg-${i}`)
            messages.push(msg)
        }

        // First page: limit=3 (gets last 3 by position DESC, reversed to ASC)
        const page1 = store.messages.getMessagesByPosition(session.id, 3)
        expect(page1).toHaveLength(3)

        // Derive cursor from oldest in page1 (first element after reverse)
        const oldest = page1[0]
        const cursorAt = oldest.invokedAt ?? oldest.createdAt
        const cursorSeq = oldest.seq

        // Second page
        const page2 = store.messages.getMessagesByPosition(session.id, 3, { at: cursorAt, seq: cursorSeq })
        expect(page2).toHaveLength(2)

        // No overlap between pages
        const page1Ids = new Set(page1.map(m => m.id))
        const page2Ids = new Set(page2.map(m => m.id))
        for (const id of page2Ids) {
            expect(page1Ids.has(id)).toBe(false)
        }

        // Together they cover all 5 messages
        expect(page1Ids.size + page2Ids.size).toBe(5)
    })

    it('long session: low-seq late-invokedAt message appears in first page', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        // Insert many normal messages first (low invokedAt)
        for (let i = 0; i < 10; i++) {
            store.messages.addMessage(session.id, `normal-${i}`)
        }
        // Insert a queued message (low seq, but invoked much later)
        const queued = store.messages.addMessage(session.id, 'queued', 'loc-q')
        store.messages.markMessagesInvoked(session.id, ['loc-q'], Date.now() + 1_000_000)

        // The queued message should appear in first page (highest position_at)
        const page1 = store.messages.getMessagesByPosition(session.id, 5)
        const ids = page1.map(m => m.id)
        expect(ids).toContain(queued.id)
        // It should be the last (most recent) in ascending result
        expect(ids[ids.length - 1]).toBe(queued.id)
    })

    it('V7 mode getMessages is unchanged after V8 migration', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-v7-compat-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV7Schema(db)
            db.exec('PRAGMA user_version = 7')
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                     VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq)
                     VALUES ('m1', 's1', '"hello"', 1000, 1), ('m2', 's1', '"world"', 2000, 2)`)
            db.close()

            const store = new Store(dbPath)
            // V7 getMessages (seq-based) must still work
            const msgs = store.messages.getMessages('s1')
            expect(msgs).toHaveLength(2)
            expect(msgs[0].seq).toBe(1)
            expect(msgs[1].seq).toBe(2)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('idx_messages_session_position index exists on fresh DB', () => {
        const store = new Store(':memory:')
        const db: Database = (store as any).db
        const rows = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_session_position'"
        ).all() as Array<{ name: string }>
        expect(rows).toHaveLength(1)
    })

    it('idx_messages_session_position index exists after V7→V8 migration', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-index-v7-v8-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV7Schema(db)
            db.exec('PRAGMA user_version = 7')
            db.close()

            const store = new Store(dbPath)
            const db2: Database = (store as any).db
            const rows = db2.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_session_position'"
            ).all() as Array<{ name: string }>
            expect(rows).toHaveLength(1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    // The web client renders queued messages from the union of the latest
    // page (getMessagesByPosition) and the uninvoked-local set
    // (getUninvokedLocalMessages). This test pins that contract at the store
    // layer: a low-position queued row must NOT appear in the latest page once
    // it's been pushed out, but it must still be discoverable via the
    // uninvoked set so the floating bar can render it.
    it('latest page + uninvoked union: queued rows pushed out of the page are still surfaced', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')

        // Queued message lands first → low createdAt; invoked_at stays NULL,
        // so its position_at = createdAt (the lowest in the session).
        const queued = store.messages.addMessage(session.id, 'queued', 'local-q')

        // Add enough later (auto-invoked) messages to push the queued row out
        // of a 3-row latest page.
        for (let i = 0; i < 5; i++) {
            store.messages.addMessage(session.id, `later-${i}`)
        }

        const pageRows = store.messages.getMessagesByPosition(session.id, 3)
        expect(pageRows).toHaveLength(3)
        expect(pageRows.find(m => m.id === queued.id)).toBeUndefined()

        // ...but the uninvoked union still surfaces it.
        const queuedRows = store.messages.getUninvokedLocalMessages(session.id)
        expect(queuedRows.map(m => m.id)).toContain(queued.id)
    })

    // Pins the latest-page ordering contract used as the cursor anchor on the
    // web side: page rows are returned in ascending position order, so
    // pageRows[0] is the oldest row in the page and is the correct anchor for
    // the next older fetch.
    it('getMessagesByPosition ascending order: pageRows[0] is the oldest in the page', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const m1 = store.messages.addMessage(session.id, 'm1')
        const m2 = store.messages.addMessage(session.id, 'm2')
        const m3 = store.messages.addMessage(session.id, 'm3')

        const page = store.messages.getMessagesByPosition(session.id, 10)
        expect(page).toHaveLength(3)
        // Ascending by position_at, with seq as the tiebreaker — m1 is oldest,
        // m3 is newest. If this ever flips, the web client's
        // `oldestPositionAt = pageRows[0].position` would anchor to the wrong
        // end of the page and the next loadMore would either gap or duplicate.
        expect(page[0].id).toBe(m1.id)
        expect(page[2].id).toBe(m3.id)
    })

    it('legacy DB (user_version=0 with V7-shape tables): step ladder backfills invoked_at and index', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-legacy-v0-'))
        const dbPath = join(dir, 'test.db')
        try {
            // Build a V7-shape schema but leave user_version = 0 (legacy DB
            // predating the version stamping).  The legacy branch in initSchema
            // must run the step ladder so the messages table picks up
            // invoked_at + idx_messages_session_position.
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV7Schema(db)
            // Intentionally do NOT set user_version — leaves it at 0.
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
                     VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq)
                     VALUES ('m1', 's1', '"hi"', 1500, 1)`)
            db.close()

            const store = new Store(dbPath)
            const cols = getMessageColumns(store)
            expect(cols).toContain('invoked_at')

            // Backfill should have happened via V7→V8 step running in the legacy branch.
            const msgs = store.messages.getMessages('s1')
            expect(msgs).toHaveLength(1)
            expect(msgs[0].invokedAt).toBe(1500)

            // The position index must exist for byPosition pagination to work.
            const db2: Database = (store as any).db
            const rows = db2.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_session_position'"
            ).all() as Array<{ name: string }>
            expect(rows).toHaveLength(1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
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
