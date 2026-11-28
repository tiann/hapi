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
        const versionStatement = internalDb.prepare('PRAGMA user_version')
        const version = versionStatement.get() as { user_version: number }
        versionStatement.finalize()
        const countPlanStatement = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT session_id, COUNT(*) FROM messages
            WHERE session_id IN (?, ?)
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND scheduled_at IS NOT NULL
              AND scheduled_at > ?
              AND delivery_state = 'queued'
            GROUP BY session_id
        `)
        const countPlan = countPlanStatement.all('a', 'b', 123) as Array<{ detail: string }>
        countPlanStatement.finalize()
        const minPlanStatement = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT session_id, MIN(scheduled_at) FROM messages
            WHERE session_id IN (?, ?)
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND scheduled_at IS NOT NULL
              AND scheduled_at > ?
              AND delivery_state = 'queued'
            GROUP BY session_id
        `)
        const minPlan = minPlanStatement.all('a', 'b', 123) as Array<{ detail: string }>
        minPlanStatement.finalize()

        expect(version.user_version).toBe(38)
        expect(countPlan.some((row) => row.detail.includes('idx_messages_future_scheduled_queued'))).toBe(true)
        expect(minPlan.some((row) => row.detail.includes('idx_messages_future_scheduled_queued'))).toBe(true)
        migrated.close()
    })

    // The v26 fast path runs the later steps by hand and returns before the
    // required-tables check; without the steps it would reach the current
    // version with no session_tasks, and the scheduler and the task routes
    // would fail on the first request.
    it('creates the session task tables and their indexes on the way', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-tasks-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

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
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        expect((internalDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(38)
        expect(internalDb.prepare(
            `SELECT name, type FROM sqlite_master
             WHERE tbl_name IN ('session_tasks', 'session_task_runs') AND name NOT LIKE 'sqlite_%'
             ORDER BY tbl_name, name`
        ).all()).toEqual([
            { name: 'idx_session_task_runs_recorded', type: 'index' },
            { name: 'idx_session_task_runs_session', type: 'index' },
            { name: 'session_task_runs', type: 'table' },
            { name: 'idx_session_tasks_active_due', type: 'index' },
            { name: 'idx_session_tasks_pending', type: 'index' },
            { name: 'idx_session_tasks_session', type: 'index' },
            { name: 'session_tasks', type: 'table' }
        ])
        const sessionId = migrated.sessions.getOrCreateSession('v26', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        const task = migrated.sessionTasks.create({
            sessionId, kind: 'repeat', items: ['ping'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1
        })
        expect(migrated.sessionTasks.findRunnable(1).map((row) => row.id)).toEqual([task.id])
        migrated.sessionTasks.recordRun({
            sessionId, taskId: task.id, taskKind: 'repeat', runNumber: null, outcome: 'skipped', scheduledFor: 1
        }, 1)
        expect(migrated.sessionTasks.listRuns(sessionId, 10)).toHaveLength(1)
        migrated.close()
    })
})
