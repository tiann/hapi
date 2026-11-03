import { expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '.'

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
            expect(version.user_version).toBe(31)
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
            expect(version.user_version).toBe(31)
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
