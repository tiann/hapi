import { afterEach, describe, expect, it } from 'bun:test'
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
        nextRunAt: 1_000,
        ...overrides
    })
}

describe('session task store', () => {
    it('creates an active task and lists it inside its session only', () => {
        const store = makeStore()
        const a = makeSession(store, 'a')
        const b = makeSession(store, 'b')

        const task = makeRepeatTask(store, a, { now: 500 })

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
            nextRunAt: 5
        })
        first.close()

        const reopened = new Store(path)
        const loaded = reopened.sessionTasks.getById(created.id)
        expect(loaded?.items).toEqual(['first', '你好', '吃饭了吗？'])
        expect(loaded?.kind).toBe('queue')
        reopened.close()
    })

    it('findRunnable returns due active tasks and tasks with a pending prompt, oldest due first', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const later = makeRepeatTask(store, session, { nextRunAt: 5_000 })
        const sooner = makeRepeatTask(store, session, { nextRunAt: 2_000 })
        const future = makeRepeatTask(store, session, { nextRunAt: 50_000 })
        const paused = makeRepeatTask(store, session, { nextRunAt: 1_000 })
        store.sessionTasks.setPaused(paused.id, true, null, 0)
        // Not due, but its prompt is out and the CLI has not acknowledged it.
        const pending = makeRepeatTask(store, session, { nextRunAt: 50_000 })
        store.sessionTasks.markSent(pending.id, { localId: 'hapi-task:x:1', nextRunAt: 110_000, now: 0 })

        expect(store.sessionTasks.findRunnable(10_000).map((row) => row.id)).toEqual([sooner.id, later.id, pending.id])
        expect(store.sessionTasks.findRunnable(10_000)).not.toContain(future)
        expect(store.sessionTasks.findRunnable(10_000)).not.toContain(paused)
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
        store.sessionTasks.setPaused(other.id, true, null, 0)
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

    it('pause, resume, error and pauseWithError', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const task = makeRepeatTask(store, session, { nextRunAt: 1_000 })

        const paused = store.sessionTasks.setPaused(task.id, true, null, 10)
        expect(paused).toMatchObject({ state: 'paused', nextRunAt: null })
        expect(store.sessionTasks.setPaused(task.id, false, 20, 20)).toMatchObject({ state: 'active', nextRunAt: 20 })

        expect(store.sessionTasks.setError(task.id, 'machine_offline', 30)).toBe(true)
        expect(store.sessionTasks.getById(task.id)?.lastError).toBe('machine_offline')
        // Same value again: nothing changed.
        expect(store.sessionTasks.setError(task.id, 'machine_offline', 31)).toBe(false)
        expect(store.sessionTasks.setError(task.id, 'send_failed', 32)).toBe(true)
        expect(store.sessionTasks.setError(task.id, null, 33)).toBe(true)
        expect(store.sessionTasks.getById(task.id)?.lastError).toBeNull()

        expect(store.sessionTasks.pauseWithError(task.id, 'session_unavailable', 40)).toBe(true)
        expect(store.sessionTasks.getById(task.id)).toMatchObject({ state: 'paused', nextRunAt: null, lastError: 'session_unavailable' })
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
        // Deleting the merged-away row no longer takes the task with it.
        store.sessions.deleteSession(from, 'default')
        expect(store.sessionTasks.getById(task.id)?.sessionId).toBe(to)
    })

    it('toSessionTask projects the wire shape', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        const queue = makeRepeatTask(store, session, { kind: 'queue', items: ['a', 'b', 'c'], maxRuns: null })
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
            pending: true
        })
    })

    it('rejects a task without prompts', () => {
        const store = makeStore()
        const session = makeSession(store, 's')
        expect(() => makeRepeatTask(store, session, { items: [] })).toThrow()
    })
})
