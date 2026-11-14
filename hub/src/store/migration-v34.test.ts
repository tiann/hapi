import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

test('upgrades an existing upstream v35 database and adds PR schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-v35-upgrade-'))
    const path = join(dir, 'hapi.db')
    let store: Store | undefined
    try {
        store = new Store(path)
        const session = store.sessions.getOrCreateSession('upgrade-test', {}, {}, 'default')
        let db = (store as unknown as { db: Database }).db
        db.exec("INSERT INTO session_jobs (session_id, job_key, label, status, heartbeat_at, started_at, updated_at, run_id) VALUES ('" + session.id + "', 'batch', 'Batch', 'running', 1, 1, 1, 'run-1')")
        db.exec("DROP INDEX IF EXISTS idx_session_scratchlist_session_position; ALTER TABLE session_scratchlist DROP COLUMN position; PRAGMA user_version = 35;")
        store.close()
        store = new Store(path)
        db = (store as unknown as { db: Database }).db
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 36 })
        expect(store.sessionJobs.get(session.id, 'batch')?.runId).toBe('run-1')
        expect(db.prepare('PRAGMA table_info(session_scratchlist)').all().map((row) => (row as { name: string }).name)).toContain('position')
    } finally {
        store?.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
})
