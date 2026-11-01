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
