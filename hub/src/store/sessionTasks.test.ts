import { afterEach, describe, expect, it } from 'bun:test'
import { type Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_TASK_RUN_PREVIEW_LENGTH } from '@hapi/protocol'
import { Store } from './index'
import {
    SESSION_TASK_RUNS_MAX_PER_SESSION,
    sessionTaskRunPreview,
    toSessionTask,
    toSessionTaskRun
} from './sessionTasks'

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
        first.sessionTasks.recordRun({
            sessionId, taskId: created.id, taskKind: 'queue', runNumber: 1, localId: 'hapi-task:q:1', outcome: 'sent', scheduledFor: 5
        }, 5)
        first.close()

        const reopened = new Store(path)
        const loaded = reopened.sessionTasks.getById(created.id)
        expect(loaded?.items).toEqual(['first', '你好', '吃饭了吗？'])
        expect(loaded?.kind).toBe('queue')
        expect(loaded?.startAt).toBe(5)
        expect(reopened.sessionTasks.listRuns(sessionId, 10).map((run) => run.localId)).toEqual(['hapi-task:q:1'])
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

    it('counts the active tasks of a session and summarizes them for the session list', () => {
        const store = makeStore()
        const a = makeSession(store, 'a')
        const b = makeSession(store, 'b')
        const c = makeSession(store, 'c')
        makeRepeatTask(store, a, { nextRunAt: 5_000 })
        makeRepeatTask(store, a, { nextRunAt: 3_000 })
        const waiting = makeRepeatTask(store, a, { nextRunAt: 1_000 })
        store.sessionTasks.markSent(waiting.id, { localId: 'hapi-task:w:1', nextRunAt: null, now: 0 })
        const paused = makeRepeatTask(store, a, { nextRunAt: 500 })
        pause(store, paused.id, 0)
        makeRepeatTask(store, b, { nextRunAt: 9_000 })

        expect(store.sessionTasks.countActive(a)).toBe(3)
        expect(store.sessionTasks.countActive(b)).toBe(1)
        expect(store.sessionTasks.countActive(c)).toBe(0)
        // A task waiting for its prompt to be taken is active but has no next run of its own.
        const summaries = store.sessionTasks.summarizeActiveBySessionIds([a, b, c], 2_000)
        expect(summaries.get(a)).toEqual({ activeTaskCount: 3, nextTaskRunAt: 3_000 })
        expect(summaries.get(b)).toEqual({ activeTaskCount: 1, nextTaskRunAt: 9_000 })
        expect(summaries.has(c)).toBe(false)
        expect(store.sessionTasks.summarizeActiveBySessionIds([], 2_000).size).toBe(0)
    })

    it('never reports a next task run in the past', () => {
        const store = makeStore()
        const a = makeSession(store, 'a')
        const b = makeSession(store, 'b')
        const c = makeSession(store, 'c')
        // Due long ago and blocked (its machine is offline): the summary says due now, not five minutes ago.
        const blocked = makeRepeatTask(store, a, { nextRunAt: 1_000 })
        makeRepeatTask(store, a, { nextRunAt: 90_000 })
        makeRepeatTask(store, b, { nextRunAt: 70_000 })
        makeRepeatTask(store, b, { nextRunAt: 95_000 })
        // Active, but its prompt is out: no next run of its own.
        const waiting = makeRepeatTask(store, c, { nextRunAt: 500 })
        store.sessionTasks.markSent(waiting.id, { localId: 'hapi-task:p:1', nextRunAt: null, now: 0 })

        const summaryAt = (now: number) => store.sessionTasks.summarizeActiveBySessionIds([a, b, c], now)
        expect(summaryAt(500).get(a)).toEqual({ activeTaskCount: 2, nextTaskRunAt: 1_000 })
        expect(summaryAt(30_000).get(a)).toEqual({ activeTaskCount: 2, nextTaskRunAt: 30_000 })
        expect(summaryAt(100_000).get(a)).toEqual({ activeTaskCount: 2, nextTaskRunAt: 100_000 })
        // Nothing due yet: the earliest one as it is.
        expect(summaryAt(30_000).get(b)).toEqual({ activeTaskCount: 2, nextTaskRunAt: 70_000 })
        expect(summaryAt(80_000).get(b)).toEqual({ activeTaskCount: 2, nextTaskRunAt: 80_000 })
        // A null next run never wins, and a session with only those has none.
        expect(summaryAt(30_000).get(c)).toEqual({ activeTaskCount: 1, nextTaskRunAt: null })
        // The task itself keeps the time it was due; only the summary is clamped.
        expect(store.sessionTasks.getById(blocked.id)?.nextRunAt).toBe(1_000)
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

    it('deleting a session removes its tasks and their runs with it', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const task = makeRepeatTask(store, session)
        store.sessionTasks.recordRun({
            sessionId: session, taskId: task.id, taskKind: 'repeat', runNumber: null, outcome: 'failed', scheduledFor: 1_000, detail: 'send_failed'
        }, 1_000)

        expect(store.sessions.deleteSession(session, 'default')).toBe(true)
        expect(store.sessionTasks.getById(task.id)).toBeNull()
        expect(store.sessionTasks.listRuns(session, 10)).toEqual([])
    })

    it('transfer moves a merged-away session\'s tasks and runs to the survivor', () => {
        const store = makeStore()
        const from = makeSession(store, 'from')
        const to = makeSession(store, 'to')
        const task = makeRepeatTask(store, from)
        makeRepeatTask(store, to)
        store.sessionTasks.recordRun({
            sessionId: from, taskId: task.id, taskKind: 'repeat', runNumber: null, outcome: 'skipped', scheduledFor: 1_000, detail: 'previous_prompt_waiting'
        }, 1_000)

        expect(store.sessionTasks.transfer(from, to)).toBe(1)
        expect(store.sessionTasks.list(to).map((row) => row.id)).toContain(task.id)
        expect(store.sessionTasks.list(from)).toEqual([])
        expect(store.sessionTasks.listRuns(to, 10).map((run) => run.taskId)).toEqual([task.id])
        expect(store.sessionTasks.listRuns(from, 10)).toEqual([])
        // Deleting the merged-away row no longer takes the task or its history with it.
        store.sessions.deleteSession(from, 'default')
        expect(store.sessionTasks.getById(task.id)?.sessionId).toBe(to)
        expect(store.sessionTasks.listRuns(to, 10)).toHaveLength(1)
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

    describe('run history', () => {
        it('records a line, stamps it when the prompt is taken, and lists the newest first', () => {
            const store = makeStore()
            const session = makeSession(store, 's')
            const task = makeRepeatTask(store, session)
            const first = store.sessionTasks.recordRun({
                sessionId: session, taskId: task.id, taskKind: 'repeat', runNumber: 1,
                localId: 'hapi-task:r:1', outcome: 'sent', scheduledFor: 1_000, preview: 'check progress'
            }, 1_000)
            const second = store.sessionTasks.recordRun({
                sessionId: session, taskId: task.id, taskKind: 'repeat', runNumber: null,
                outcome: 'skipped', scheduledFor: 61_000, detail: 'previous_prompt_waiting'
            }, 61_000)

            expect(first).toMatchObject({
                taskId: task.id,
                taskKind: 'repeat',
                runNumber: 1,
                localId: 'hapi-task:r:1',
                outcome: 'sent',
                scheduledFor: 1_000,
                recordedAt: 1_000,
                takenAt: null,
                detail: null,
                preview: 'check progress'
            })
            expect(store.sessionTasks.listRuns(session, 10).map((run) => run.id)).toEqual([second.id, first.id])
            expect(store.sessionTasks.listRuns(session, 1).map((run) => run.id)).toEqual([second.id])
            expect(toSessionTaskRun(first)).toEqual({
                id: first.id,
                sessionId: session,
                taskId: task.id,
                taskKind: 'repeat',
                runNumber: 1,
                outcome: 'sent',
                scheduledFor: 1_000,
                recordedAt: 1_000,
                takenAt: null,
                detail: null,
                preview: 'check progress'
            })

            expect(store.sessionTasks.markRunTaken(session, 'hapi-task:r:1', 3_000)).toBe(true)
            expect(store.sessionTasks.listRuns(session, 10).at(-1)?.takenAt).toBe(3_000)
            // Only a waiting sent prompt is stamped, and only once.
            expect(store.sessionTasks.markRunTaken(session, 'hapi-task:r:1', 4_000)).toBe(false)
            expect(store.sessionTasks.markRunTaken(session, 'hapi-task:none', 4_000)).toBe(false)
        })

        it('flips a waiting sent prompt to cancelled, and nothing else', () => {
            const store = makeStore()
            const session = makeSession(store, 's')
            const task = makeRepeatTask(store, session)
            store.sessionTasks.recordRun({
                sessionId: session, taskId: task.id, taskKind: 'repeat', runNumber: 1, localId: 'hapi-task:c:1', outcome: 'sent', scheduledFor: 1_000
            }, 1_000)
            store.sessionTasks.recordRun({
                sessionId: session, taskId: task.id, taskKind: 'repeat', runNumber: null, localId: 'hapi-task:c:x', outcome: 'failed', scheduledFor: 61_000
            }, 61_000)
            store.sessionTasks.markRunTaken(session, 'hapi-task:c:1', 2_000)
            store.sessionTasks.recordRun({
                sessionId: session, taskId: task.id, taskKind: 'repeat', runNumber: 2, localId: 'hapi-task:c:2', outcome: 'sent', scheduledFor: 61_000
            }, 61_000)

            // Taken already: not cancelled.
            expect(store.sessionTasks.markRunCancelled(session, 'hapi-task:c:1')).toBe(false)
            // Not a sent prompt.
            expect(store.sessionTasks.markRunCancelled(session, 'hapi-task:c:x')).toBe(false)
            expect(store.sessionTasks.markRunCancelled(session, 'hapi-task:c:2')).toBe(true)
            expect(store.sessionTasks.listRuns(session, 10).map((run) => [run.runNumber, run.outcome, run.takenAt])).toEqual([
                [2, 'cancelled', null],
                [null, 'failed', null],
                [1, 'sent', 2_000]
            ])
        })

        it(`keeps at most ${SESSION_TASK_RUNS_MAX_PER_SESSION} rows per session and leaves other sessions alone`, () => {
            const store = makeStore()
            const a = makeSession(store, 'a')
            const b = makeSession(store, 'b')
            for (let index = 0; index < SESSION_TASK_RUNS_MAX_PER_SESSION + 20; index += 1) {
                store.sessionTasks.recordRun({
                    sessionId: a, taskId: 't', taskKind: 'repeat', runNumber: null, outcome: 'skipped', scheduledFor: index
                }, index)
            }
            store.sessionTasks.recordRun({ sessionId: b, taskId: 't', taskKind: 'repeat', runNumber: null, outcome: 'skipped', scheduledFor: 1 }, 1)

            const runs = store.sessionTasks.listRuns(a, 1_000)
            expect(runs).toHaveLength(SESSION_TASK_RUNS_MAX_PER_SESSION)
            expect(runs[0].scheduledFor).toBe(SESSION_TASK_RUNS_MAX_PER_SESSION + 19)
            expect(runs.at(-1)?.scheduledFor).toBe(20)
            expect(store.sessionTasks.listRuns(b, 10)).toHaveLength(1)
        })

        it('prunes rows recorded before a cutoff', () => {
            const store = makeStore()
            const session = makeSession(store, 's')
            const record = (taskId: string, at: number) => store.sessionTasks.recordRun({
                sessionId: session, taskId, taskKind: 'repeat', runNumber: null, outcome: 'skipped', scheduledFor: null
            }, at)
            record('old', 100)
            record('edge', 1_000)
            record('new', 2_000)

            expect(store.sessionTasks.pruneRuns(1_000)).toBe(1)
            expect(store.sessionTasks.listRuns(session, 10).map((run) => run.taskId)).toEqual(['new', 'edge'])
            expect(store.sessionTasks.pruneRuns(1_000)).toBe(0)
        })

        it('cuts a preview to the wire length', () => {
            const long = 'x'.repeat(SESSION_TASK_RUN_PREVIEW_LENGTH + 10)
            expect(sessionTaskRunPreview(long)).toBe('x'.repeat(SESSION_TASK_RUN_PREVIEW_LENGTH))
            expect(sessionTaskRunPreview('short')).toBe('short')
            // By characters, not UTF-16 units.
            expect(Array.from(sessionTaskRunPreview('你好'.repeat(SESSION_TASK_RUN_PREVIEW_LENGTH))).length).toBe(SESSION_TASK_RUN_PREVIEW_LENGTH)
        })
    })
})
