import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const directories: string[] = []
afterEach(async () => {
    for (const directory of directories.splice(0)) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                await rm(directory, { recursive: true, force: true })
                break
            } catch (error) {
                if (attempt === 4) {
                    // Bun can release SQLite handles just after Store.close() on Windows.
                    if ((error as NodeJS.ErrnoException).code === 'EBUSY') break
                    throw error
                }
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
        }
    }
})

function createLegacy(version: number, hasPositions = false) {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-scratchlist-v30-'))
    directories.push(directory)
    const path = join(directory, 'hapi.db')
    const original = new Store(path)
    const session = original.sessions.getOrCreateSession('migration', { path: '/tmp', host: 'test' }, null, 'default')
    original.sessions.updateReadState(session.id, 'default', { type: 'unread', expectedVersion: 0 })
    original.close()
    const legacy = new Database(path)
    legacy.exec('DROP INDEX idx_session_scratchlist_session_position')
    if (!hasPositions) legacy.exec('ALTER TABLE session_scratchlist DROP COLUMN position')
    legacy.prepare(`INSERT INTO session_scratchlist (session_id, entry_id, text, created_at, updated_at, attachments${hasPositions ? ', position' : ''})
        VALUES (?, 'older', 'keep old draft', 100, 500, '[]'${hasPositions ? ', 0' : ''}),
               (?, 'newer', 'keep new draft', 200, 300, '[]'${hasPositions ? ', 1' : ''})`).run(session.id, session.id)
    legacy.exec(`PRAGMA user_version = ${version}`)
    legacy.close()
    return { path, sessionId: session.id }
}

describe('scratchlist order schema through v31', () => {
    for (const version of [25, 26, 27, 28, 29, 30]) {
        it(`upgrades v${version} without reordering the existing newest-first draft list`, () => {
            const { path, sessionId } = createLegacy(version)
            const store = new Store(path)
            try {
                expect(store.scratchlist.list(sessionId).map(entry => [entry.entryId, entry.position, entry.text])).toEqual([
                    ['newer', 0, 'keep new draft'], ['older', 1, 'keep old draft'],
                ])
                const db = (store as unknown as { db: Database }).db
                expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 31 })
                expect(store.sessions.getSession(sessionId)?.readState).toEqual({ readRevision: 0, manualUnread: true, version: 1 })
                expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_session_scratchlist_session_position'").get()).not.toBeNull()
            } finally { store.close() }
        })
    }

    it('preserves already persisted positions and remains stable after reopening', () => {
        const { path, sessionId } = createLegacy(29, true)
        for (let attempt = 0; attempt < 2; attempt++) {
            const store = new Store(path)
            try {
                expect(store.scratchlist.list(sessionId).map(entry => [entry.entryId, entry.position])).toEqual([['older', 0], ['newer', 1]])
            } finally { store.close() }
        }
    })
})

it('upgrades timestamp-era history to a read baseline exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-read-migration-'))
    directories.push(dir)
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
})