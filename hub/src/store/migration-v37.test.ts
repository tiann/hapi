import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { SESSION_TASKS_TABLE_SQL } from './sessionTasks'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v36 to v37', () => {
    it('adds the session_tasks table and its indexes to a v36 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v36-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_session_tasks_pending;
            DROP INDEX idx_session_tasks_active_due;
            DROP INDEX idx_session_tasks_session;
            DROP TABLE session_tasks;
            PRAGMA user_version = 36;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const objects = internalDb.prepare(
            "SELECT name, type FROM sqlite_master WHERE tbl_name = 'session_tasks' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all() as Array<{ name: string; type: string }>

        expect(version.user_version).toBe(37)
        expect(objects).toEqual([
            { name: 'idx_session_tasks_active_due', type: 'index' },
            { name: 'idx_session_tasks_pending', type: 'index' },
            { name: 'idx_session_tasks_session', type: 'index' },
            { name: 'session_tasks', type: 'table' }
        ])

        // Prompts inserted by tasks cascade with their session.
        const sessionId = migrated.sessions.getOrCreateSession('v37', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        migrated.sessionTasks.create({
            sessionId,
            kind: 'queue',
            items: ['a'],
            intervalMs: 60_000,
            maxRuns: null,
            nextRunAt: 1
        })
        migrated.sessions.deleteSession(sessionId, 'default')
        expect(migrated.sessionTasks.list(sessionId)).toEqual([])
        migrated.close()
    })

    it('is idempotent when the table already exists', () => {
        const store = new Store(':memory:')
        const sessionId = store.sessions.getOrCreateSession('idempotent', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        const task = store.sessionTasks.create({
            sessionId,
            kind: 'repeat',
            items: ['a'],
            intervalMs: 60_000,
            maxRuns: null,
            nextRunAt: 1
        })
        const internalDb = (store as unknown as { db: Database }).db
        // Re-running the step's DDL (a database that stopped mid-upgrade) keeps the row.
        internalDb.exec(SESSION_TASKS_TABLE_SQL)
        internalDb.exec(SESSION_TASKS_TABLE_SQL)
        expect(store.sessionTasks.getById(task.id)?.id).toBe(task.id)
        store.close()
    })
})
