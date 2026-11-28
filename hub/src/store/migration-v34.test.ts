import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

test.each([35, 36])('upgrades upstream v%s and adds task schema without losing passkeys', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-v35-upgrade-'))
    const path = join(dir, 'hapi.db')
    let store: Store | undefined
    try {
        store = new Store(path)
        const session = store.sessions.getOrCreateSession('upgrade-test', {}, {}, 'default')
        let db = (store as unknown as { db: Database }).db
        db.exec("INSERT INTO session_jobs (session_id, job_key, label, status, heartbeat_at, started_at, updated_at, run_id) VALUES ('" + session.id + "', 'batch', 'Batch', 'running', 1, 1, 1, 'run-1')")
        if (version === 35) {
            db.exec('DROP TABLE passkey_credentials;')
        } else {
            db.exec("INSERT INTO passkey_credentials (id, namespace, rp_id, public_key, token_fingerprint, created_at) VALUES ('fixture-key', 'default', 'example.test', x'01', 'fixture', 1)")
        }
        db.exec(`DROP TABLE migration_state; ALTER TABLE sessions DROP COLUMN todos_source_at; ALTER TABLE sessions DROP COLUMN todos_source_seq; PRAGMA user_version = ${version};`)
        store.close()
        store = new Store(path)
        db = (store as unknown as { db: Database }).db
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 37 })
        expect(db.prepare('SELECT id FROM passkey_credentials').all()).toEqual(version === 36 ? [{ id: 'fixture-key' }] : [])
        expect(store.sessionJobs.get(session.id, 'batch')?.runId).toBe('run-1')
        expect(db.prepare('PRAGMA table_info(sessions)').all().map((row) => (row as { name: string }).name)).toContain('todos_source_seq')
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name='migration_state'").get()).not.toBeNull()
    } finally {
        store?.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
})
