import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

/**
 * v37→v38: `start_at` on session_tasks. Every path that builds the schema
 * (fresh, the step ladder, the legacy chain) must end up with it.
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

/** The session_tasks objects by name; empty when the table is missing. */
function taskObjects(db: Database): Array<{ name: string; type: string }> {
    return db.prepare(
        `SELECT name, type FROM sqlite_master
         WHERE tbl_name = 'session_tasks' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
    ).all() as Array<{ name: string; type: string }>
}

const EXPECTED_TASK_OBJECTS = [
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

/** Take a current database back to the v37 shape: no `start_at`. */
function downgradeToV37(db: Database): void {
    db.exec(`
        ALTER TABLE session_tasks DROP COLUMN start_at;
        PRAGMA user_version = 37;
    `)
}

describe('schema migration v37 to v38', () => {
    it('adds start_at to a v37 database, dated from creation for existing tasks', () => {
        const dbPath = tempDatabasePath('v37')
        const original = new Store(dbPath)
        const sessionId = original.sessions.getOrCreateSession('v37', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        const task = original.sessionTasks.create({
            sessionId, kind: 'repeat', items: ['ping'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1, now: 5_000
        })
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
        // The task predates the column: its first run is taken to be when it was created.
        expect(migrated.sessionTasks.getById(task.id)).toMatchObject({ startAt: 5_000, createdAt: 5_000, runCount: 0 })
        migrated.close()
    })

    it('is idempotent when the column already exists', () => {
        const store = new Store(':memory:')
        const sessionId = store.sessions.getOrCreateSession('idempotent-v38', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        const task = store.sessionTasks.create({
            sessionId, kind: 'queue', items: ['a'], intervalMs: 60_000, maxRuns: null, startAt: 1, nextRunAt: 1
        })
        const step = (store as unknown as { migrateFromV37ToV38: () => void }).migrateFromV37ToV38.bind(store)
        // A database that stopped mid-upgrade runs the step again.
        step()
        step()
        expect(store.sessionTasks.getById(task.id)?.id).toBe(task.id)
        expect(taskObjects((store as unknown as { db: Database }).db)).toEqual(EXPECTED_TASK_OBJECTS)
        store.close()
    })

    it('a fresh database has the final shape', () => {
        const store = new Store(':memory:')
        const internalDb = (store as unknown as { db: Database }).db
        expect(userVersion(internalDb)).toBe(38)
        expect(taskObjects(internalDb)).toEqual(EXPECTED_TASK_OBJECTS)
        // The column cascades with its session like the rest of the task.
        const sessionId = store.sessions.getOrCreateSession('fresh-v38', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
        const task = store.sessionTasks.create({
            sessionId, kind: 'repeat', items: ['ping'], intervalMs: 60_000, maxRuns: null, startAt: 7, nextRunAt: 7
        })
        expect(task.startAt).toBe(7)
        store.sessions.deleteSession(sessionId, 'default')
        expect(store.sessionTasks.getById(task.id)).toBeNull()
        store.close()
    })

    it('the legacy chain (user_version 0 with tables) creates the table with the column', () => {
        const dbPath = tempDatabasePath('legacy')
        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_session_tasks_pending;
            DROP INDEX idx_session_tasks_active_due;
            DROP INDEX idx_session_tasks_session;
            DROP TABLE session_tasks;
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
