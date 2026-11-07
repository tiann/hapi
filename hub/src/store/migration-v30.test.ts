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

describe('schema migration v29 to v32', () => {
    it('skips the task-source ALTER when a partial legacy database has no sessions table', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v30-partial-'))
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
            expect(version.user_version).toBe(32)
        } finally {
            migrated.close()
        }
    })

    it('adds the structured task source position columns to a V29 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v30-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        initial.sessions.getOrCreateSession('migration-v30-session', { path: '/tmp', host: 'h' }, null, 'default')
        initial.close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE migration_state;
            ALTER TABLE sessions DROP COLUMN todos_source_seq;
            ALTER TABLE sessions DROP COLUMN todos_source_at;
            PRAGMA user_version = 29;
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
        expect(version.user_version).toBe(32)
        const markerStatement = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'"
        )
        const marker = markerStatement.get()
        markerStatement.finalize()
        expect(marker).not.toBeNull()
        const indexStatement = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_future_scheduled_queued'"
        )
        const index = indexStatement.get()
        indexStatement.finalize()
        expect(index).not.toBeNull()
        expect(source).toEqual({ todos_source_at: null, todos_source_seq: null })
        migrated.close()
    })

    it('reconciles a branch V28 database that predated session_turns and last_user_message_at', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v30-branch-v28-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        const session = initial.sessions.getOrCreateSession('branch-v28-session', { path: '/tmp', host: 'h' }, null, 'default')
        initial.close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE session_turns;
            ALTER TABLE sessions DROP COLUMN last_user_message_at;
            PRAGMA user_version = 28;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const versionStatement = internalDb.prepare('PRAGMA user_version')
        const version = versionStatement.get() as { user_version: number }
        versionStatement.finalize()

        expect(version.user_version).toBe(32)
        expect(migrated.turns.open(session.id, 'default', 1_000, 'agent')).toBe(true)
        migrated.close()
    })
    it('upgrades an unmodified V30 database with the task-source migration', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v30-base-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        initial.sessions.getOrCreateSession('base-v30-session', { path: '/tmp', host: 'h' }, null, 'default')
        initial.close()
        const base = new Database(dbPath)
        base.exec(`
            DROP TABLE migration_state;
            ALTER TABLE sessions DROP COLUMN todos_source_seq;
            ALTER TABLE sessions DROP COLUMN todos_source_at;
            PRAGMA user_version = 30;
        `)
        base.close()

        const migrated = new Store(dbPath)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            const columns = internalDb.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            const marker = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'"
            ).get()
            expect(version.user_version).toBe(32)
            expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
                'todos_source_at',
                'todos_source_seq'
            ]))
            expect(marker).not.toBeNull()
        } finally {
            migrated.close()
        }
    })
})

it('upgrades timestamp-era history to a read baseline exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-read-migration-'))
    try {
        const path = join(dir, 'hub.db')
        const before = new Store(path)
        const id = before.sessions.getOrCreateSession('s', {}, null, 'default').id
        const reply = { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'history' } } }
        before.messages.addMessage(id, reply, 'old')
        before.close()
        const legacy = new Database(path)
        for (const column of ['content_revision', 'read_revision', 'read_state_version', 'manual_unread']) {
            legacy.exec(`ALTER TABLE sessions DROP COLUMN ${column}`)
        }
        legacy.exec('ALTER TABLE messages DROP COLUMN content_revision; PRAGMA user_version = 29;')
        legacy.close()
        const migrated = new Store(path)
        expect(migrated.sessions.getSession(id)?.readState).toEqual({ readRevision: 0, manualUnread: false, version: 0 })
        expect(migrated.sessions.getSession(id)?.contentRevision).toBe(0)
        expect(migrated.messages.getMessages(id)).toHaveLength(1)
        migrated.messages.addMessage(id, reply, 'new')
        migrated.close()
        const restarted = new Store(path)
        expect(restarted.sessions.getSession(id)?.contentRevision).toBe(1)
        expect(restarted.sessions.getSession(id)?.readState?.readRevision).toBe(0)
        restarted.close()
    } finally { Bun.gc(true); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})
it('adds the structured task source migration to an existing v31 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v31-task-source-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'hapi.db')

    const initial = new Store(dbPath)
    initial.sessions.getOrCreateSession('migration-v31-session', { path: '/tmp' }, null, 'default')
    initial.close()

    const legacy = new Database(dbPath)
    legacy.exec(`
        DROP TABLE migration_state;
        ALTER TABLE sessions DROP COLUMN todos_source_seq;
        ALTER TABLE sessions DROP COLUMN todos_source_at;
        PRAGMA user_version = 31;
    `)
    legacy.close()

    const migrated = new Store(dbPath)
    try {
        const internalDb = (migrated as unknown as { db: Database }).db
        const columns = internalDb.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const marker = internalDb.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'"
        ).get()

        expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            'todos_source_at',
            'todos_source_seq'
        ]))
        expect(marker).not.toBeNull()
        expect(version.user_version).toBe(32)
    } finally {
        migrated.close()
    }
})
it('creates and backfills search tables when upgrading a base v30 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-search-v30-migration-'))
    try {
        const path = join(dir, 'hub.db')
        const before = new Store(path)
        const session = before.sessions.getOrCreateSession('search-v30', { path: '/tmp/search-v30' }, null, 'default')
        before.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'upgrade searchable text' } })
        before.close()
        const legacy = new Database(path)
        legacy.exec(`
            DROP TABLE message_content_search_short;
            DROP TABLE message_content_search_lookup;
            DROP TABLE message_content_search;
            PRAGMA user_version = 30;
        `)
        legacy.close()
        const migrated = new Store(path)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            expect(version.user_version).toBe(32)
            expect(migrated.messages.searchContent('searchable', 'default')[0]?.sessionId).toBe(session.id)
        } finally { migrated.close() }
    } finally { Bun.gc(true); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

it('upgrades a genuine v26 schema without read-state or search table shortcuts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-v26-current-migration-'))
    try {
        const path = join(dir, 'hub.db')
        const before = new Store(path)
        const session = before.sessions.getOrCreateSession('v26-current', { path: '/tmp/v26-current' }, null, 'default')
        before.close()
        const legacy = new Database(path)
        legacy.exec(`
            DROP TABLE session_turns;
            DROP TABLE message_content_search_short;
            DROP TABLE message_content_search_lookup;
            DROP TABLE message_content_search;
            ALTER TABLE messages DROP COLUMN content_revision;
            ALTER TABLE sessions DROP COLUMN manual_unread;
            ALTER TABLE sessions DROP COLUMN read_state_version;
            ALTER TABLE sessions DROP COLUMN read_revision;
            ALTER TABLE sessions DROP COLUMN content_revision;
            ALTER TABLE sessions DROP COLUMN last_user_message_at;
            PRAGMA user_version = 26;
        `)
        legacy.close()
        const migrated = new Store(path)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            expect(version.user_version).toBe(32)
            expect(migrated.sessions.getSession(session.id)?.readState).toEqual({ readRevision: 0, manualUnread: false, version: 0 })
            migrated.messages.addMessage(session.id, {
                role: 'user', content: { type: 'text', text: 'genuine v26 searchable text' }
            })
            const read = migrated.sessions.updateReadState(session.id, 'default', {
                type: 'unread', expectedVersion: 0
            })
            expect(read?.readState).toEqual({ readRevision: 0, manualUnread: true, version: 1 })
            expect(migrated.messages.searchContent('genuine v26', 'default')[0]?.sessionId).toBe(session.id)
        } finally { migrated.close() }
    } finally { Bun.gc(true); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})
