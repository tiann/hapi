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
    } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('adds attachment tables when upgrading an unmodified v30 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-attachment-migration-v31-'))
    try {
        const path = join(dir, 'hub.db')
        const initial = new Store(path)
        initial.close()
        const legacy = new Database(path)
        legacy.exec(`
            DROP TABLE attachment_creations;
            DROP TABLE attachment_deletions;
            DROP TABLE attachments;
            PRAGMA user_version = 30;
        `)
        legacy.close()

        const migrated = new Store(path)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            const tables = internalDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('attachments', 'attachment_deletions', 'attachment_creations')"
            ).all() as Array<{ name: string }>
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            expect(tables.map((table) => table.name).sort()).toEqual([
                'attachment_creations', 'attachment_deletions', 'attachments'
            ])
            expect(version.user_version).toBe(31)
        } finally { migrated.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
