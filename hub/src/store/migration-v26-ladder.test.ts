import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

describe('v26 fast-path upgrade (#1717)', () => {
    it('lands every later column, not just the ones listed by hand', () => {
        // The v26 branch used to enumerate each later migration explicitly, so
        // a step added to the ladder but not copied here was skipped while the
        // row was still stamped at SCHEMA_VERSION. The database then claimed a
        // version whose columns it did not have and the hub failed to start.
        const dir = mkdtempSync(join(tmpdir(), 'hapi-v26-'))
        const path = join(dir, 'hub.db')
        new Store(path).close()

        const legacy = new Database(path)
        // Genuinely remove the post-v26 columns, otherwise `createSchema` has
        // already added them and the test cannot see a skipped migration.
        for (const column of [
            'last_notify_status', 'last_notify_at', 'last_notify_note',
            'last_notify_cleared_at', 'last_notify_updated_at',
            'blocked_ack_at', 'blocked_ack_reason', 'blocked_ack_key'
        ]) {
            try { legacy.exec(`ALTER TABLE sessions DROP COLUMN ${column};`) } catch { /* absent */ }
        }
        legacy.exec('PRAGMA user_version = 26;')
        legacy.close()

        const migrated = new Store(path)
        try {
            const db = (migrated as unknown as { db: Database }).db
            const columns = new Set(
                (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
                    .map((row) => row.name)
            )
            for (const column of [
                'last_notify_status', 'last_notify_at', 'last_notify_note',
                'last_notify_cleared_at', 'last_notify_updated_at',
                'blocked_ack_at', 'blocked_ack_reason', 'blocked_ack_key'
            ]) {
                expect(columns.has(column)).toBe(true)
            }
            // And a session actually loads, which is what the hub does at boot.
            expect(() => migrated.sessions.getSessions()).not.toThrow()
        } finally {
            migrated.close()
        }
    })
})
