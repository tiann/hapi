import { expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '.'

const UNINVOKED_LOCAL_SQL = `
    EXPLAIN QUERY PLAN
    SELECT * FROM messages
    WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL
    ORDER BY seq ASC
`

function planUsesUninvokedLocalIndex(db: Database): boolean {
    const plan = db.prepare(UNINVOKED_LOCAL_SQL).all('s') as Array<{ detail: string }>
    return plan.some((row) => row.detail.includes('idx_messages_uninvoked_local'))
}

it('indexes the uninvoked-local-message lookup on a fresh database and when upgrading from v36', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v37-'))
    try {
        const path = join(dir, 'hapi.db')
        const fresh = new Store(path)
        try {
            const freshDb = (fresh as unknown as { db: Database }).db
            expect(planUsesUninvokedLocalIndex(freshDb)).toBe(true)
        } finally { fresh.close() }

        const legacy = new Database(path)
        legacy.exec('DROP INDEX idx_messages_uninvoked_local; PRAGMA user_version = 36;')
        legacy.close()

        const migrated = new Store(path)
        try {
            const db = (migrated as unknown as { db: Database }).db
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(37)
            expect(planUsesUninvokedLocalIndex(db)).toBe(true)
        } finally { migrated.close() }
    } finally { Bun.gc(true); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})
