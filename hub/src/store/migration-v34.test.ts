import { expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '.'

it('adds an index used by the uninvoked-local-message lookup when upgrading from v34', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v34-'))
    try {
        const path = join(dir, 'hapi.db')
        new Store(path).close()
        const legacy = new Database(path)
        legacy.exec('DROP INDEX idx_messages_uninvoked_local; PRAGMA user_version = 34;')
        legacy.close()

        const migrated = new Store(path)
        const db = (migrated as unknown as { db: Database }).db
        const plan = db.prepare(`
            EXPLAIN QUERY PLAN
            SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL ORDER BY seq ASC
        `).all('s') as Array<{ detail: string }>
        expect(plan.some((row) => row.detail.includes('idx_messages_uninvoked_local'))).toBe(true)
        migrated.close()
    } finally { Bun.gc(true); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})
