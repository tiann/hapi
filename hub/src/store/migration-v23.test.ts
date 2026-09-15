import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { MAX_INDEXED_MESSAGE_CHARACTERS } from './messageContentSearch'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migrations through v30', () => {
    it('adds events and event_links tables to a V22 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v23-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE IF EXISTS event_links;
            DROP TABLE IF EXISTS events;
            PRAGMA user_version = 22;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            const events = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"
            ).get() as { name: string } | null
            const links = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_links'"
            ).get() as { name: string } | null
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

            expect(events?.name).toBe('events')
            expect(links?.name).toBe('event_links')
            const columns = internalDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
            expect(columns.map((column) => column.name)).toContain('delivery_state')
            expect(version.user_version).toBe(30)
        } finally {
            migrated.close()
        }
    })

    it('creates and backfills the message content search index after the v26 schema', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        const session = initial.sessions.getOrCreateSession('migration-search', { path: '/tmp/migration-search' }, null, 'default')
        initial.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'backfill this message' }
        })
        initial.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE IF EXISTS message_content_search;
            DROP TABLE IF EXISTS message_content_search_lookup;
            DROP TABLE IF EXISTS message_content_search_short;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        try {
            expect(migrated.messages.searchContent('backfill this', 'default')[0]?.sessionId).toBe(session.id)
            const internalDb = (migrated as unknown as { db: Database }).db
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            expect(version.user_version).toBe(30)
        } finally {
            migrated.close()
        }
    })

    it('adds the indexed message lookup to an existing v27 search schema', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        const session = initial.sessions.getOrCreateSession('migration-lookup', { path: '/tmp/migration-lookup' }, null, 'default')
        initial.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'backfill the lookup table' }
        })
        initial.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE IF EXISTS message_content_search_lookup;
            DROP TABLE IF EXISTS message_content_search_short;
            PRAGMA user_version = 27;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        try {
            expect(migrated.messages.searchContent('lookup table', 'default')[0]?.sessionId).toBe(session.id)
            const internalDb = (migrated as unknown as { db: Database }).db
            const lookup = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_content_search_lookup'"
            ).get() as { name: string } | null
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            expect(lookup?.name).toBe('message_content_search_lookup')
            expect(version.user_version).toBe(30)
        } finally {
            migrated.close()
        }
    })

    it('backfills indexed short-query grams for an existing v28 search schema', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v28-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        const session = initial.sessions.getOrCreateSession('migration-short-query', { path: '/tmp/migration-short-query' }, null, 'default')
        const text = `你好，短查询索引 ${Array.from({ length: MAX_INDEXED_MESSAGE_CHARACTERS + 1024 }, (_, index) =>
            String.fromCodePoint(0x1000 + index)
        ).join('')} tail-migration-needle`
        const message = initial.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text }
        })
        initial.close()

        const legacy = new Database(dbPath)
        legacy.prepare(
            'UPDATE message_content_search SET searchable_text = ? WHERE message_id = ?'
        ).run(text, message.id)
        legacy.exec(`
            DROP TABLE IF EXISTS message_content_search_lookup;
            CREATE TABLE message_content_search_lookup (
                search_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL UNIQUE
            );
            INSERT INTO message_content_search_lookup (search_rowid, message_id)
            SELECT rowid, message_id FROM message_content_search;
            DROP TABLE IF EXISTS message_content_search_short;
            PRAGMA user_version = 28;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        try {
            expect(migrated.messages.searchContent('你好', 'default')[0]?.sessionId).toBe(session.id)
            expect(migrated.messages.searchContent('tail-migration-needle', 'default')[0]?.sessionId)
                .toBe(session.id)
            const internalDb = (migrated as unknown as { db: Database }).db
            const shortIndex = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_content_search_short'"
            ).get() as { name: string } | null
            const lookupColumns = internalDb.prepare(
                'PRAGMA table_info(message_content_search_lookup)'
            ).all() as Array<{ name: string }>
            const target = internalDb.prepare(
                'SELECT target_message_id FROM message_content_search_lookup WHERE message_id = ?'
            ).get(message.id) as { target_message_id: string } | undefined
            const indexed = internalDb.prepare(
                'SELECT searchable_text FROM message_content_search WHERE message_id = ?'
            ).get(message.id) as { searchable_text: string } | undefined
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            expect(shortIndex?.name).toBe('message_content_search_short')
            expect(lookupColumns.map((column) => column.name)).toContain('target_message_id')
            expect(target?.target_message_id).toBe(message.id)
            expect(indexed?.searchable_text.length).toBeLessThanOrEqual(MAX_INDEXED_MESSAGE_CHARACTERS)
            expect(indexed?.searchable_text).toContain('tail-migration-needle')
            expect(version.user_version).toBe(30)
        } finally {
            migrated.close()
        }
    })

    it('rebuilds a v29 content index with the larger cap and truncation metadata', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v29-content-search-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const initial = new Store(dbPath)
        const session = initial.sessions.getOrCreateSession(
            'migration-content-cap',
            { path: '/tmp/migration-content-cap' },
            null,
            'default'
        )
        const text = `${'a'.repeat(16_000)} v30-middle-needle ${'b'.repeat(18_000)}`
        const message = initial.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text }
        })
        initial.close()

        // Simulate the v29 derived index without deleting any user data. The
        // old 16 KiB head/tail window misses the marker near its midpoint.
        const legacy = new Database(dbPath)
        const legacyIndexedText = `${text.slice(0, 8_191)} ${text.slice(-8_192)}`
        legacy.prepare(
            'UPDATE message_content_search SET searchable_text = ? WHERE message_id = ?'
        ).run(legacyIndexedText, message.id)
        legacy.prepare(
            `UPDATE message_content_search_lookup
             SET is_truncated = 0, short_index_truncated = 0
             WHERE target_message_id = ?`
        ).run(message.id)
        legacy.exec('PRAGMA user_version = 29')
        legacy.close()

        const migrated = new Store(dbPath)
        try {
            expect(migrated.messages.searchContent('v30-middle-needle', 'default'))
                .toMatchObject([{ sessionId: session.id, truncated: true }])

            const internalDb = (migrated as unknown as { db: Database }).db
            const indexed = internalDb.prepare(`
                SELECT searchable_text
                FROM message_content_search
                WHERE message_id = ?
            `).get(message.id) as { searchable_text: string } | undefined
            const metadata = internalDb.prepare(`
                SELECT is_truncated, short_index_truncated
                FROM message_content_search_lookup
                WHERE target_message_id = ?
            `).get(message.id) as { is_truncated: number; short_index_truncated: number } | undefined
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }

            expect(indexed?.searchable_text.length).toBeLessThanOrEqual(MAX_INDEXED_MESSAGE_CHARACTERS)
            expect(indexed?.searchable_text).toContain('v30-middle-needle')
            expect(metadata?.is_truncated).toBe(1)
            expect(metadata?.short_index_truncated).toBe(1)
            expect(version.user_version).toBe(30)
        } finally {
            migrated.close()
        }
    })
})
