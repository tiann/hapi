import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v26 to v27', () => {
    it('adds an index used by the session-list future-scheduled lookups', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_future_scheduled_queued;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const countPlan = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT session_id, COUNT(*) FROM messages
            WHERE session_id IN (?, ?)
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND scheduled_at IS NOT NULL
              AND scheduled_at > ?
              AND delivery_state = 'queued'
            GROUP BY session_id
        `).all('a', 'b', 123) as Array<{ detail: string }>
        const minPlan = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT session_id, MIN(scheduled_at) FROM messages
            WHERE session_id IN (?, ?)
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND scheduled_at IS NOT NULL
              AND scheduled_at > ?
              AND delivery_state = 'queued'
            GROUP BY session_id
        `).all('a', 'b', 123) as Array<{ detail: string }>

        expect(version.user_version).toBe(27)
        expect(countPlan.some((row) => row.detail.includes('idx_messages_future_scheduled_queued'))).toBe(true)
        expect(minPlan.some((row) => row.detail.includes('idx_messages_future_scheduled_queued'))).toBe(true)
        migrated.close()
    })
})
