import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { SESSION_TASK_RUNS_TABLE_SQL } from './sessionTasks'

/**
 * v37→v38: `start_at` on session_tasks and the `session_task_runs` history.
 * Every path that builds the schema (fresh, the step ladder, the v26 fast
 * path, the legacy chain) must end up with both.
 */

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function tempDatabasePath(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-${tag}-`))
    tempDirs.push(dir)
    return join(dir, 'hapi.db')
}

/** The phase-1 and phase-2 objects by name; `undefined` when a table is missing. */
function taskObjects(db: Database): Array<{ name: string; type: string }> {
    return db.prepare(
        `SELECT name, type FROM sqlite_master
         WHERE tbl_name IN ('session_tasks', 'session_task_runs') AND name NOT LIKE 'sqlite_%'
         ORDER BY tbl_name, name`
    ).all() as Array<{ name: string; type: string }>
}

const EXPECTED_TASK_OBJECTS = [
    { name: 'idx_session_task_runs_recorded', type: 'index' },
    { name: 'idx_session_task_runs_session', type: 'index' },
    { name: 'session_task_runs', type: 'table' },
    { name: 'idx_session_tasks_active_due', type: 'index' },
    { name: 'idx_session_tasks_pending', type: 'index' },
    { name: 'idx_session_tasks_session', type: 'index' },
    { name: 'session_tasks', type: 'table' }
]

function userVersion(db: Database): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
}

/** Take a current database back to the v37 shape: no `start_at`, no run history. */
function downgradeToV37(db: Database): void {
    db.exec(`
        DROP INDEX idx_session_task_runs_session;
        DROP INDEX idx_session_task_runs_recorded;
        DROP TABLE session_task_runs;
        ALTER TABLE session_tasks DROP COLUMN start_at;
        PRAGMA user_version = 37;
    `)
}

describe('schema migration v37 to v38', () => {
    it('adds start_at and the run history table to a v37 database, keeping each task\'s planned first run', () => {
        const dbPath = tempDatabasePath('v37')
        const original = new Store(dbPath)
        const sessionId = original.sessions.getOrCreateSession('v37', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        // Phase 1 (v37) had no start_at: a task's planned first run lived in next_run_at alone.
        const planned = original.sessionTasks.create({
            sessionId, kind: 'repeat', items: ['ping'], intervalMs: 60_000, maxRuns: null, startAt: 9_000, nextRunAt: 9_000, now: 5_000
        })
        const overdue = original.sessionTasks.create({
            sessionId, kind: 'queue', items: ['a'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1, now: 6_000
        })
        const ran = original.sessionTasks.create({
            sessionId, kind: 'repeat', items: ['pong'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1, now: 7_000
        })
        original.sessionTasks.markSent(ran.id, { localId: 'hapi-task:v37:1', nextRunAt: 61_000, now: 8_000 })
        original.sessionTasks.settlePending(ran.id, { consumedAt: 8_500, now: 8_500 })
        const paused = original.sessionTasks.create({
            sessionId, kind: 'queue', items: ['b'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1, now: 9_000
        })
        original.sessionTasks.update(paused.id, { state: { paused: true, nextRunAt: null } }, 9_500)
        original.close()

        const legacy = new Database(dbPath)
        downgradeToV37(legacy)
        expect(columnNames(legacy, 'session_tasks')).not.toContain('start_at')
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(38)
        expect(taskObjects(internalDb)).toEqual(EXPECTED_TASK_OBJECTS)
        const startAt = (internalDb.prepare('PRAGMA table_info(session_tasks)').all() as Array<{ name: string; notnull: number }>)
            .find((column) => column.name === 'start_at')
        expect(startAt?.notnull).toBe(1)
        // A task that has not run yet keeps the time its user chose, so a pause and resume does not fire it at once.
        expect(migrated.sessionTasks.getById(planned.id)).toMatchObject({ startAt: 9_000, nextRunAt: 9_000, runCount: 0 })
        expect(migrated.sessionTasks.getById(overdue.id)).toMatchObject({ startAt: 1, runCount: 0 })
        // One that has run is dated from when it was created; a paused one has no next run to take.
        expect(migrated.sessionTasks.getById(ran.id)).toMatchObject({ startAt: 7_000, createdAt: 7_000, runCount: 1 })
        expect(migrated.sessionTasks.getById(paused.id)).toMatchObject({ startAt: 9_000, createdAt: 9_000, state: 'paused' })
        migrated.sessionTasks.recordRun({
            sessionId, taskId: planned.id, taskKind: 'repeat', runNumber: 1, localId: 'hapi-task:v38:1', outcome: 'sent', scheduledFor: 9_000
        }, 9_000)
        expect(migrated.sessionTasks.listRuns(sessionId, 10)).toHaveLength(1)
        migrated.close()
    })

    it('is idempotent when the column and the table already exist', () => {
        const store = new Store(':memory:')
        const sessionId = store.sessions.getOrCreateSession('idempotent-v38', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        const task = store.sessionTasks.create({
            sessionId, kind: 'queue', items: ['a'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1
        })
        store.sessionTasks.recordRun({
            sessionId, taskId: task.id, taskKind: 'queue', runNumber: null, outcome: 'skipped', scheduledFor: 1
        }, 1)
        const step = (store as unknown as { migrateFromV37ToV38: () => void }).migrateFromV37ToV38.bind(store)
        // A database that stopped mid-upgrade runs the step again.
        step()
        step()
        expect(store.sessionTasks.getById(task.id)?.id).toBe(task.id)
        expect(store.sessionTasks.listRuns(sessionId, 10)).toHaveLength(1)
        const internalDb = (store as unknown as { db: Database }).db
        internalDb.exec(SESSION_TASK_RUNS_TABLE_SQL)
        expect(taskObjects(internalDb)).toEqual(EXPECTED_TASK_OBJECTS)
        store.close()
    })

    it('a fresh database has the final shape', () => {
        const store = new Store(':memory:')
        const internalDb = (store as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(38)
        expect(taskObjects(internalDb)).toEqual(EXPECTED_TASK_OBJECTS)
        expect(columnNames(internalDb, 'session_task_runs')).toEqual([
            'id', 'session_id', 'task_id', 'task_kind', 'run_number', 'local_id', 'outcome',
            'scheduled_for', 'recorded_at', 'taken_at', 'detail', 'preview'
        ])
        // The history cascades with its session like the tasks do.
        const sessionId = store.sessions.getOrCreateSession('fresh-v38', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        store.sessionTasks.recordRun({
            sessionId, taskId: 't', taskKind: 'repeat', runNumber: null, outcome: 'failed', scheduledFor: null, detail: 'send_failed'
        }, 1)
        store.sessions.deleteSession(sessionId, 'default')
        expect(store.sessionTasks.listRuns(sessionId, 10)).toEqual([])
        store.close()
    })

    it('the legacy chain (user_version 0 with tables) creates both tables', () => {
        const dbPath = tempDatabasePath('legacy')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_session_tasks_pending;
            DROP INDEX idx_session_tasks_active_due;
            DROP INDEX idx_session_tasks_session;
            DROP TABLE session_tasks;
            DROP INDEX idx_session_task_runs_session;
            DROP INDEX idx_session_task_runs_recorded;
            DROP TABLE session_task_runs;
            PRAGMA user_version = 0;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(38)
        expect(taskObjects(internalDb)).toEqual(EXPECTED_TASK_OBJECTS)
        const sessionId = migrated.sessions.getOrCreateSession('legacy-v38', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        expect(migrated.sessionTasks.create({
            sessionId, kind: 'repeat', items: ['ping'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1
        }).startAt).toBe(1)
        migrated.close()
    })
})
