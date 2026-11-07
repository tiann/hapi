import { afterEach, describe, expect, it } from 'bun:test'
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

const scratchlistDirs: string[] = []
afterEach(() => {
    for (const directory of scratchlistDirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
})

function createScratchlistLegacy(version: number, hasPositions = false, dropReadState = false) {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-scratchlist-v30-'))
    scratchlistDirs.push(directory)
    const path = join(directory, 'hapi.db')
    const original = new Store(path)
    const session = original.sessions.getOrCreateSession('migration', { path: '/tmp', host: 'test' }, null, 'default')
    original.sessions.updateReadState(session.id, 'default', { type: 'unread', expectedVersion: 0 })
    original.close()
    const legacy = new Database(path)
    legacy.exec('DROP INDEX idx_session_scratchlist_session_position')
    if (!hasPositions) legacy.exec('ALTER TABLE session_scratchlist DROP COLUMN position')
    if (dropReadState) {
        legacy.exec(`
            ALTER TABLE messages DROP COLUMN content_revision;
            ALTER TABLE sessions DROP COLUMN manual_unread;
            ALTER TABLE sessions DROP COLUMN read_state_version;
            ALTER TABLE sessions DROP COLUMN read_revision;
            ALTER TABLE sessions DROP COLUMN content_revision;
        `)
    }
    legacy.prepare(`INSERT INTO session_scratchlist (session_id, entry_id, text, created_at, updated_at, attachments${hasPositions ? ', position' : ''})
        VALUES (?, 'older', 'keep old draft', 100, 500, '[]'${hasPositions ? ', 0' : ''}),
               (?, 'newer', 'keep new draft', 200, 300, '[]'${hasPositions ? ', 1' : ''})`).run(session.id, session.id)
    legacy.exec(`PRAGMA user_version = ${version}`)
    legacy.close()
    return { path, sessionId: session.id }
}

describe('scratchlist order schema through v32', () => {
    for (const version of [25, 26, 27, 28, 29, 30, 31]) {
        it(`upgrades v${version} without reordering the existing newest-first draft list`, () => {
            const { path, sessionId } = createScratchlistLegacy(version)
            const store = new Store(path)
            try {
                expect(store.scratchlist.list(sessionId).map(entry => [entry.entryId, entry.position, entry.text])).toEqual([
                    ['newer', 0, 'keep new draft'], ['older', 1, 'keep old draft'],
                ])
                const db = (store as unknown as { db: Database }).db
                expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 32 })
                expect(store.sessions.getSession(sessionId)?.readState).toEqual({ readRevision: 0, manualUnread: true, version: 1 })
                expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_session_scratchlist_session_position'").get()).not.toBeNull()
            } finally { store.close() }
        })
    }

    it('repairs read-state columns in a v30 database created by the earlier scratchlist migration', () => {
        const { path, sessionId } = createScratchlistLegacy(30, false, true)
        const store = new Store(path)
        try {
            expect(store.sessions.getSession(sessionId)?.readState).toEqual({
                readRevision: 0,
                manualUnread: false,
                version: 0,
            })
            expect(store.scratchlist.list(sessionId).map(entry => [entry.entryId, entry.position])).toEqual([
                ['newer', 0], ['older', 1],
            ])
            const db = (store as unknown as { db: Database }).db
            expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 32 })
        } finally { store.close() }
    })

    it('preserves already persisted positions and remains stable after reopening', () => {
        const { path, sessionId } = createScratchlistLegacy(29, true)
        for (let attempt = 0; attempt < 2; attempt++) {
            const store = new Store(path)
            try {
                expect(store.scratchlist.list(sessionId).map(entry => [entry.entryId, entry.position])).toEqual([['older', 0], ['newer', 1]])
            } finally { store.close() }
        }
    })
})