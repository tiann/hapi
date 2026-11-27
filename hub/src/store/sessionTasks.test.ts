import { afterEach, describe, expect, it } from 'bun:test'
import { type Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { toSessionTask } from './sessionTasks'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string): string {
    return store.sessions.getOrCreateSession(tag, { path: '/tmp', flavor: 'cursor' }, null, 'default').id
}

function makeRepeatTask(store: Store, sessionId: string, overrides: Partial<Parameters<Store['sessionTasks']['create']>[0]> = {}) {
    return store.sessionTasks.create({
        sessionId,
        kind: 'repeat',
        items: ['check progress'],
        intervalMs: 60_000,
        maxRuns: null,
        startAt: 1_000,
        nextRunAt: 1_000,
        ...overrides
    })
}

function pause(store: Store, taskId: string, now: number) {
    return store.sessionTasks.update(taskId, { state: { paused: true, nextRunAt: null } }, now)
}

function queryPlan(store: Store, sql: string, ...params: SQLQueryBindings[]): string[] {
    const db = (store as unknown as { db: Database }).db
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail)
}

describe('session task store', () => {
    it('creates an active task and lists it inside its session only', () => {
        const store = makeStore()
        const a = makeSession(store, 'a')
        const b = makeSession(store, 'b')

        const task = makeRepeatTask(store, a, { now: 500, startAt: 900 })

        expect(task.id).toMatch(/[0-9a-f-]{36}/)
        expect(task).toMatchObject({
            sessionId: a,
            kind: 'repeat',
            state: 'active',
            items: ['check progress'],
            intervalMs: 60_000,
            maxRuns: null,
            runCount: 0,
            nextRunAt: 1_000,
            startAt: 900,
            pendingLocalId: null,
            lastError: null,
            createdAt: 500,
            updatedAt: 500
        })
        expect(store.sessionTasks.list(a).map((row) => row.id)).toEqual([task.id])
        expect(store.sessionTasks.list(b)).toEqual([])
        expect(store.sessionTasks.get(a, task.id)?.id).toBe(task.id)
        // The same id does not resolve through another session.
        expect(store.sessionTasks.get(b, task.id)).toBeNull()
        expect(store.sessionTasks.getById(task.id)?.id).toBe(task.id)
    })

    it('persists items and survives reopening the database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-session-tasks-'))
        tempDirs.push(dir)
        const path = join(dir, 'hapi.db')
        const first = new Store(path)
        const sessionId = makeSession(first, 'queued')
        const created = first.sessionTasks.create({
            sessionId,
            kind: 'queue',
            items: ['first', '你好', '吃饭了吗？'],
            intervalMs: 10 * 60_000,
            maxRuns: null,
            startAt: 5,
            nextRunAt: 5
        })
        first.close()

        const reopened = new Store(path)
        const loaded = reopened.sessionTasks.getById(created.id)
        expect(loaded?.items).toEqual(['first', '你好', '吃饭了吗？'])
        expect(loaded?.kind).toBe('queue')
        expect(loaded?.startAt).toBe(5)
        reopened.close()
    })

    it('findRunnable returns due active tasks and tasks with a pending prompt, oldest due first', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const later = makeRepeatTask(store, session, { nextRunAt: 5_000 })
        const sooner = makeRepeatTask(store, session, { nextRunAt: 2_000 })
        const future = makeRepeatTask(store, session, { nextRunAt: 50_000 })
        const paused = makeRepeatTask(store, session, { nextRunAt: 1_000 })
        pause(store, paused.id, 0)
        // Not due, but its prompt is out and the CLI has not acknowledged it.
        const pending = makeRepeatTask(store, session, { nextRunAt: 50_000 })
        store.sessionTasks.markSent(pending.id, { localId: 'hapi-task:x:1', nextRunAt: 110_000, now: 0 })
        // Due again while its first prompt is still waiting: in both halves, listed once.
        const dueAndPending = makeRepeatTask(store, session, { nextRunAt: 3_000 })
        store.sessionTasks.markSent(dueAndPending.id, { localId: 'hapi-task:y:1', nextRunAt: 3_000, now: 0 })
        // Paused with a prompt out: still tracked, after everything that has a next run.
        const pausedPending = makeRepeatTask(store, session, { nextRunAt: 1_000 })
        store.sessionTasks.markSent(pausedPending.id, { localId: 'hapi-task:z:1', nextRunAt: 61_000, now: 0 })
        pause(store, pausedPending.id, 1)

        const runnable = store.sessionTasks.findRunnable(10_000)
        expect(runnable.map((row) => row.id)).toEqual([sooner.id, dueAndPending.id, later.id, pending.id, pausedPending.id])
        expect(runnable.filter((row) => row.id === dueAndPending.id)).toHaveLength(1)
        expect(runnable.map((row) => row.id)).not.toContain(future.id)
        expect(runnable.map((row) => row.id)).not.toContain(paused.id)
    })

    it('findRunnable reads the two partial indexes instead of scanning the table', () => {
        const store = makeStore()
        const pendingPlan = queryPlan(store, 'SELECT id FROM session_tasks WHERE pending_local_id IS NOT NULL')
        expect(pendingPlan.some((step) => step.includes('idx_session_tasks_pending'))).toBe(true)
        const duePlan = queryPlan(store,
            'SELECT id FROM session_tasks WHERE state = \'active\' AND next_run_at IS NOT NULL AND next_run_at <= ?', 1)
        expect(duePlan.some((step) => step.includes('idx_session_tasks_active_due'))).toBe(true)
        // The phase-1 single OR query could not use either.
        expect([...pendingPlan, ...duePlan].some((step) => step.startsWith('SCAN session_tasks'))).toBe(false)
    })

    it('markSent counts a send once and keeps a paused task unscheduled', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const task = makeRepeatTask(store, session, { nextRunAt: 1_000 })

        expect(store.sessionTasks.markSent(task.id, { localId: 'hapi-task:a:1', nextRunAt: 61_000, now: 1_000 })).toBe(true)
        // A second send cannot be recorded while the first prompt is pending.
        expect(store.sessionTasks.markSent(task.id, { localId: 'hapi-task:a:2', nextRunAt: 121_000, now: 1_001 })).toBe(false)

        const sent = store.sessionTasks.getById(task.id)!
        expect(sent).toMatchObject({
            runCount: 1,
            pendingLocalId: 'hapi-task:a:1',
            lastRunAt: 1_000,
            nextRunAt: 61_000,
            lastError: null
        })

        const other = makeRepeatTask(store, session, { nextRunAt: 1_000 })
        pause(store, other.id, 0)
        expect(store.sessionTasks.markSent(other.id, { localId: 'hapi-task:b:1', nextRunAt: 61_000, now: 0 })).toBe(true)
        expect(store.sessionTasks.getById(other.id)).toMatchObject({ state: 'paused', nextRunAt: null, runCount: 1 })
    })

    it('settlePending clears the prompt and replaces or keeps the next run', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const queue = makeRepeatTask(store, session, { kind: 'queue', items: ['a', 'b'], maxRuns: null, nextRunAt: 1_000 })
        store.sessionTasks.markSent(queue.id, { localId: 'hapi-task:q:1', nextRunAt: null, now: 1_000 })

        expect(store.sessionTasks.settlePending(queue.id, { consumedAt: 4_000, nextRunAt: 64_000, now: 4_000 })).toBe(true)
        expect(store.sessionTasks.getById(queue.id)).toMatchObject({
            pendingLocalId: null,
            lastConsumedAt: 4_000,
            nextRunAt: 64_000
        })
        // Nothing pending any more: a second acknowledgement is a no-op.
        expect(store.sessionTasks.settlePending(queue.id, { consumedAt: 9_000, nextRunAt: 99_000, now: 9_000 })).toBe(false)
        expect(store.sessionTasks.getById(queue.id)?.nextRunAt).toBe(64_000)

        const repeat = makeRepeatTask(store, session, { nextRunAt: 1_000 })
        store.sessionTasks.markSent(repeat.id, { localId: 'hapi-task:r:1', nextRunAt: 61_000, now: 1_000 })
        store.sessionTasks.setError(repeat.id, 'machine_offline', 1_000)
        // Undefined nextRunAt keeps the grid the send already recorded.
        expect(store.sessionTasks.settlePending(repeat.id, { consumedAt: 4_000, now: 4_000 })).toBe(true)
        expect(store.sessionTasks.getById(repeat.id)).toMatchObject({ nextRunAt: 61_000, lastError: null })
    })

    it('skipDueSlot only moves an active task that has a prompt pending', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const pending = makeRepeatTask(store, session, { nextRunAt: 1_000 })
        store.sessionTasks.markSent(pending.id, { localId: 'hapi-task:p:1', nextRunAt: 61_000, now: 1_000 })
        const idle = makeRepeatTask(store, session, { nextRunAt: 1_000 })

        expect(store.sessionTasks.skipDueSlot(pending.id, 121_000, 61_000)).toBe(true)
        expect(store.sessionTasks.getById(pending.id)?.nextRunAt).toBe(121_000)
        expect(store.sessionTasks.skipDueSlot(idle.id, 121_000, 61_000)).toBe(false)
    })

    it('update changes the given fields, pauses and resumes, and clears the error on a state change', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const task = makeRepeatTask(store, session, { nextRunAt: 1_000 })

        const paused = store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, 10)!
        expect(paused).toMatchObject({ state: 'paused', nextRunAt: null, updatedAt: 10 })
        store.sessionTasks.setError(task.id, 'session_archived', 11)
        expect(store.sessionTasks.update(task.id, { state: { paused: false, nextRunAt: 20 } }, 20)).toMatchObject({
            state: 'active', nextRunAt: 20, lastError: null
        })

        const edited = store.sessionTasks.update(task.id, {
            items: ['a', 'b'],
            intervalMs: 5_000,
            maxRuns: 7
        }, 30)!
        expect(edited).toMatchObject({ items: ['a', 'b'], intervalMs: 5_000, maxRuns: 7, state: 'active', nextRunAt: 20, updatedAt: 30 })
        // Fields that are not in the change set stay; maxRuns null removes the limit.
        expect(store.sessionTasks.update(task.id, { maxRuns: null }, 31)).toMatchObject({ maxRuns: null, intervalMs: 5_000 })
        expect(store.sessionTasks.update('missing', { intervalMs: 5_000 }, 32)).toBeNull()
    })

    it('error state', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const task = makeRepeatTask(store, session, { nextRunAt: 1_000 })

        expect(store.sessionTasks.setError(task.id, 'machine_offline', 30)).toBe(true)
        expect(store.sessionTasks.getById(task.id)?.lastError).toBe('machine_offline')
        // Same value again: nothing changed.
        expect(store.sessionTasks.setError(task.id, 'machine_offline', 31)).toBe(false)
        expect(store.sessionTasks.setError(task.id, 'session_archived', 32)).toBe(true)
        expect(store.sessionTasks.setError(task.id, null, 33)).toBe(true)
        expect(store.sessionTasks.getById(task.id)?.lastError).toBeNull()
    })

    it('deleting a session removes its tasks with it', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const task = makeRepeatTask(store, session)

        expect(store.sessions.deleteSession(session, 'default')).toBe(true)
        expect(store.sessionTasks.getById(task.id)).toBeNull()
    })

    it('transfer moves a merged-away session\'s tasks to the survivor', () => {
        const store = makeStore()
        const from = makeSession(store, 'from')
        const to = makeSession(store, 'to')
        const task = makeRepeatTask(store, from)
        makeRepeatTask(store, to)

        expect(store.sessionTasks.transfer(from, to)).toBe(1)
        expect(store.sessionTasks.list(to).map((row) => row.id)).toContain(task.id)
        expect(store.sessionTasks.list(from)).toEqual([])
        store.sessions.deleteSession(from, 'default')
        expect(store.sessionTasks.getById(task.id)?.sessionId).toBe(to)
    })

    it('toSessionTask projects the wire shape', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const queue = makeRepeatTask(store, session, { kind: 'queue', items: ['a', 'b', 'c'], maxRuns: null, startAt: 1_500 })
        expect(toSessionTask(queue)).toEqual({
            id: queue.id,
            sessionId: session,
            kind: 'queue',
            state: 'active',
            items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
            intervalMs: 60_000,
            maxRuns: null,
            runCount: 0,
            totalRuns: 3,
            nextRunAt: 1_000,
            pending: false,
            startAt: 1_500,
            lastRunAt: null,
            lastError: null,
            createdAt: queue.createdAt,
            updatedAt: queue.createdAt
        })

        const repeat = makeRepeatTask(store, session, { maxRuns: 5 })
        store.sessionTasks.markSent(repeat.id, { localId: 'hapi-task:r:1', nextRunAt: 61_000, now: 1_000 })
        expect(toSessionTask(store.sessionTasks.getById(repeat.id)!)).toMatchObject({
            kind: 'repeat',
            maxRuns: 5,
            totalRuns: 5,
            runCount: 1,
            pending: true,
            startAt: 1_000
        })
    })

    it('rejects a task without prompts', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        expect(() => makeRepeatTask(store, session, { items: [] })).toThrow()
    })
})
