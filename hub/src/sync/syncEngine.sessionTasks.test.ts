import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
    SESSION_TASK_MAX_ACTIVE_PER_SESSION,
    SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX,
    type CreateSessionTaskRequest,
    type SessionTask
} from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

type FakeSession = { id: string; namespace: string; active: boolean; metadata?: { lifecycleState?: string } }

/**
 * Minimal construction, the same pattern as sessionJobWake.engine.test.ts:
 * Object.create skips field initializers, so only the collaborators a test
 * reaches for are seeded.
 */
function stubEngine(store: Store, sessions: Map<string, FakeSession>) {
    const engine = Object.create(SyncEngine.prototype) as SyncEngine
    const events: SyncEvent[] = []
    const internals = engine as unknown as Record<string, unknown>
    internals.store = store
    internals.sessionCache = {
        getSession: (id: string) => sessions.get(id),
        expireInactive: () => [],
        getSessions: () => [...sessions.values()],
        reconcileKeepaliveIdle: () => undefined
    }
    internals.machineCache = { expireInactive: () => undefined }
    internals.historyActionsInFlight = new Set<string>()
    internals.eventPublisher = { emit: (event: SyncEvent) => { events.push(event) } }
    internals.openCodeRewindPending = () => false
    internals.reconcileOpenCodeClears = async () => undefined
    internals.reconcileDerivedToolWork = () => undefined
    // The 5s tick asks for mature scheduled messages; none in these tests.
    internals.messageService = { releaseMatureScheduledMessages: () => [] }
    return { engine, events, internals }
}

function makeSession(store: Store, tag: string, metadata?: Record<string, unknown>): FakeSession {
    const id = store.sessions.getOrCreateSession(tag, { path: '/tmp', flavor: 'cursor', ...metadata }, null, 'default').id
    return { id, namespace: 'default', active: true }
}

function harness(tag = 'tasks') {
    const store = new Store(':memory:')
    const session = makeSession(store, tag)
    const sessions = new Map<string, FakeSession>([[session.id, session]])
    const { engine, events, internals } = stubEngine(store, sessions)
    const sent: Array<{ sessionId: string; text: string; localId: string; sentFrom?: string }> = []
    ;(engine as unknown as { sendMessage: (id: string, payload: { text: string; localId: string; sentFrom?: string }) => Promise<void> }).sendMessage = async (id, payload) => {
        sent.push({ sessionId: id, ...payload })
        store.addMessageForCurrentSession(
            id,
            { role: 'user', content: { type: 'text', text: payload.text }, meta: { sentFrom: 'webapp' } },
            payload.localId,
            null
        )
    }
    /** A confirmed cancel, as the message service performs one on a queued row. */
    const cancelled: Array<{ sessionId: string; localId: string }> = []
    ;(engine as unknown as { cancelQueuedMessage: (id: string, localId: string) => Promise<unknown> }).cancelQueuedMessage = async (id, localId) => {
        cancelled.push({ sessionId: id, localId })
        store.messages.deleteQueuedMessageById(id, localId)
        return { status: 'cancelled', localId }
    }
    return { store, session, sessions, engine, events, internals, sent, cancelled }
}

type Harness = ReturnType<typeof harness>

function tick(engine: SyncEngine): void {
    // The 5s hub timer entry point.
    ;(engine as unknown as { expireInactive(): void }).expireInactive()
}

const HOUR = 60 * 60_000
/** Let the scheduler's microtasks (and the tick it starts) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The task of a result that carries one. */
function taskOf(result: { type: string; task?: SessionTask }): SessionTask {
    if (!result.task) throw new Error(`unexpected result: ${result.type}`)
    return result.task
}

describe('SyncEngine session tasks', () => {
    afterEach(() => {
        mock.restore()
    })

    it('creates a repeat task with its first run at startAt and announces the change', () => {
        const h = harness()
        const startAt = Date.now() + HOUR
        const result = h.engine.createSessionTask(h.session.id, {
            kind: 'repeat',
            text: '  report  ',
            intervalMs: 60_000,
            maxRuns: 3,
            startAt
        })
        expect(result.type).toBe('created')
        const task = taskOf(result)

        expect(task).toMatchObject({
            sessionId: h.session.id,
            kind: 'repeat',
            state: 'active',
            items: [{ text: '  report  ' }],
            intervalMs: 60_000,
            maxRuns: 3,
            totalRuns: 3,
            runCount: 0,
            pending: false,
            startAt,
            lastError: null
        })
        expect(task.nextRunAt).toBe(startAt)
        expect(h.events).toEqual([{ type: 'session-tasks-changed', sessionId: h.session.id }])
        expect(h.engine.listSessionTasks(h.session.id)).toEqual([task])
    })

    it('creates a queue task and runs a task that is due right away', async () => {
        const h = harness()
        const before = Date.now()
        const task = taskOf(h.engine.createSessionTask(h.session.id, {
            kind: 'queue',
            items: [{ text: 'first' }, { text: '你好' }],
            intervalMs: 60_000
        }))
        expect(task).toMatchObject({ kind: 'queue', totalRuns: 2, maxRuns: null, runCount: 0 })
        // The first run defaults to now (the millisecond may tick between the two reads).
        expect(task.startAt).toBeGreaterThanOrEqual(before)
        expect(task.startAt).toBeLessThanOrEqual(Date.now())
        expect(task.nextRunAt).toBe(task.startAt)

        // createSessionTask kicks the scheduler instead of waiting for the 5s tick.
        await settle()
        expect(h.sent).toEqual([{
            sessionId: h.session.id,
            text: 'first',
            localId: `${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}${task.id}:1`,
            sentFrom: 'webapp'
        }])
        expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ runCount: 1, pending: true, nextRunAt: null })
    })

    it('clamps a first run that is already past to now', () => {
        const h = harness()
        const before = Date.now()
        const task = taskOf(h.engine.createSessionTask(h.session.id, {
            kind: 'repeat',
            text: 'ping',
            intervalMs: 60_000,
            startAt: before - 30_000
        }))
        expect(task.startAt).toBe(before - 30_000)
        expect(task.nextRunAt).toBeGreaterThanOrEqual(before)
    })

    it(`answers too-many-tasks at ${SESSION_TASK_MAX_ACTIVE_PER_SESSION} active tasks, not counting paused ones`, () => {
        const h = harness()
        for (let index = 0; index < SESSION_TASK_MAX_ACTIVE_PER_SESSION; index += 1) {
            const created = h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: `ping ${index}`, intervalMs: 60_000, startAt: Date.now() + HOUR })
            expect(created.type).toBe('created')
        }
        const overflow = h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000 })
        expect(overflow.type).toBe('too-many-tasks')
        expect(h.engine.listSessionTasks(h.session.id)).toHaveLength(SESSION_TASK_MAX_ACTIVE_PER_SESSION)
        expect(h.events.filter((event) => event.type === 'session-tasks-changed')).toHaveLength(SESSION_TASK_MAX_ACTIVE_PER_SESSION)

        const paused = h.engine.listSessionTasks(h.session.id)[0]
        h.engine.updateSessionTask(h.session.id, paused.id, { paused: true })
        expect(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000 }).type).toBe('created')
    })

    it('summarizes the active tasks of the listed sessions', () => {
        const h = harness()
        const other = makeSession(h.store, 'other')
        h.sessions.set(other.id, other)
        const first = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() + HOUR }))
        const soon = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000, startAt: Date.now() + 2 * HOUR }))

        const summaries = h.engine.getSessionTaskSummaries([h.session.id, other.id])
        expect(summaries.get(h.session.id)).toEqual({ activeTaskCount: 2, nextTaskRunAt: Math.min(first.nextRunAt as number, soon.nextRunAt as number) })
        expect(summaries.has(other.id)).toBe(false)
    })

    describe('updateSessionTask', () => {
        function createLater(h: Harness, request: CreateSessionTaskRequest): SessionTask {
            return taskOf(h.engine.createSessionTask(h.session.id, { ...request, startAt: Date.now() + HOUR } as CreateSessionTaskRequest))
        }

        it('pause clears the schedule and the stored error', () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            h.store.sessionTasks.setError(task.id, 'machine_offline', Date.now())

            const paused = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))
            expect(paused).toMatchObject({ state: 'paused', nextRunAt: null, lastError: null })
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })
        })

        it('resume runs a task with nothing pending now', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() - 1_000 }))
            h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            const before = Date.now()

            const resumed = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed.state).toBe('active')
            expect(resumed.nextRunAt).toBeGreaterThanOrEqual(before)
            await settle()
            expect(h.sent).toHaveLength(1)
        })

        it('resume keeps the first run of a task that has not run yet', async () => {
            const h = harness()
            const startAt = Date.now() + 2 * HOUR
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000, startAt }))
            h.engine.updateSessionTask(h.session.id, task.id, { paused: true })

            const resumed = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed).toMatchObject({ state: 'active', startAt })
            expect(resumed.nextRunAt).toBe(startAt)
            await settle()
            expect(h.sent).toEqual([])
        })

        it('resume keeps a queue task spaced from when its last prompt was taken', () => {
            const h = harness()
            const now = Date.now()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 30 * 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:x:1', nextRunAt: null, now })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: now - 5 * 60_000, nextRunAt: now + 25 * 60_000, now })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, now)

            // Paused for a moment: the rest of the spacing is kept.
            expect(taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false })).nextRunAt).toBe(now + 25 * 60_000)
        })

        it('resume runs a queue task whose spacing elapsed while it was paused', () => {
            const h = harness()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 30 * 60_000 })
            const takenAt = Date.now() - 3 * HOUR
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:x:1', nextRunAt: null, now: takenAt })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: takenAt, nextRunAt: takenAt + 30 * 60_000, now: takenAt })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, takenAt + 1000)
            const before = Date.now()

            expect(taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false })).nextRunAt).toBeGreaterThanOrEqual(before)
        })

        it('resume leaves a queue task unscheduled while its prompt is still pending', () => {
            const h = harness()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:y:1', nextRunAt: null, now: Date.now() })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, Date.now())

            const resumed = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed).toMatchObject({ state: 'active', nextRunAt: null, pending: true })
        })

        it('leaves the schedule of a task that is already running alone', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

            const untouched = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(untouched.nextRunAt).toBe(task.nextRunAt)
            await settle()
            expect(h.sent).toEqual([])
        })

        it('returns not-found for a task that is not in this session', () => {
            const h = harness()
            createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            expect(h.engine.updateSessionTask(h.session.id, 'missing', { paused: true })).toEqual({ type: 'not-found' })
        })

        it('replaces the prompt of a repeat task', () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

            const edited = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { text: 'pong' }))
            expect(edited.items).toEqual([{ text: 'pong' }])
            expect(edited).toMatchObject({ nextRunAt: task.nextRunAt, state: 'active' })
        })

        it('replaces the prompts a queue has not sent yet and keeps the ones it has', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], intervalMs: 60_000 }))
            await settle()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['a'])

            const edited = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { items: [{ text: 'x' }, { text: 'y' }] }))
            expect(edited.items).toEqual([{ text: 'a' }, { text: 'x' }, { text: 'y' }])
            expect(edited).toMatchObject({ runCount: 1, pending: true, totalRuns: 3 })

            // The queue goes on with the new prompts.
            h.store.messages.markMessagesInvoked(h.session.id, [h.sent[0].localId], Date.now())
            tick(h.engine)
            await settle()
            expect(h.engine.runSessionTaskNow(h.session.id, task.id).type).toBe('queued')
            await settle()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['a', 'x'])
        })

        it('re-anchors a task with nothing pending to one interval from now', () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            const before = Date.now()

            const edited = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { intervalMs: 10 * 60_000 }))
            expect(edited.intervalMs).toBe(10 * 60_000)
            // Nothing has run yet: the first run stays where it was put.
            expect(edited.nextRunAt).toBe(task.nextRunAt)

            // A task that has run, with nothing pending, moves its next run.
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:r:1', nextRunAt: before + 60_000, now: before })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: before + 1, now: before + 1 })
            const reAnchored = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { intervalMs: 10 * 60_000 }))
            expect(reAnchored.nextRunAt).toBeGreaterThanOrEqual(before + 10 * 60_000)
            expect(reAnchored.nextRunAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
        })

        it('re-anchors a resumed task to one new interval from now', () => {
            const h = harness()
            const now = Date.now()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:ra:1', nextRunAt: now + 60_000, now })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: now, now })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, now)

            const resumed = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false, intervalMs: 10 * 60_000 }))
            expect(resumed).toMatchObject({ state: 'active', intervalMs: 10 * 60_000 })
            expect(resumed.nextRunAt).toBeGreaterThanOrEqual(now + 10 * 60_000)
            expect(resumed.nextRunAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
        })

        it('does not resume a paused task when only its interval is edited', async () => {
            const h = harness()
            const now = Date.now()
            /** A task that has run once, with its prompt taken, and is now paused. */
            function pausedAfterOneRun(request: CreateSessionTaskRequest) {
                const task = createLater(h, request)
                h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:interval:1', nextRunAt: null, now })
                h.store.sessionTasks.settlePending(task.id, { consumedAt: now + 1, nextRunAt: now + 60_000, now: now + 1 })
                expect(taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))).toMatchObject({ state: 'paused', runCount: 1, pending: false })
                return task
            }
            const repeat = pausedAfterOneRun({ kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            const queue = pausedAfterOneRun({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 })

            // An edit form that submits only the changed field must not start an unattended sender again.
            for (const task of [repeat, queue]) {
                const edited = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { intervalMs: 10 * 60_000 }))
                expect(edited).toMatchObject({ id: task.id, state: 'paused', nextRunAt: null, intervalMs: 10 * 60_000, runCount: 1 })
            }
            await settle()
            expect(h.sent).toEqual([])
        })

        it('ends the task when it is resumed with a limit equal to what already ran, instead of sending one more', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000, maxRuns: 5 })
            const now = Date.now()
            for (let run = 1; run <= 3; run += 1) {
                h.store.sessionTasks.markSent(task.id, { localId: `hapi-task:end:${run}`, nextRunAt: now + 60_000, now })
                h.store.sessionTasks.settlePending(task.id, { consumedAt: now + run, now: now + run })
            }
            h.engine.updateSessionTask(h.session.id, task.id, { paused: true })

            const ended = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false, maxRuns: 3 }))
            expect(ended).toMatchObject({ state: 'active', maxRuns: 3, totalRuns: 3, runCount: 3 })
            // The limit is reached and nothing is pending: there is nothing left to resume.
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })
            await settle()
            expect(h.sent).toEqual([])
        })

        it('refuses to resume a task while the session holds the cap of active tasks', async () => {
            const h = harness()
            const paused = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'paused', intervalMs: 60_000, startAt: Date.now() + HOUR }))
            h.engine.updateSessionTask(h.session.id, paused.id, { paused: true })
            const active: SessionTask[] = []
            for (let index = active.length; index < SESSION_TASK_MAX_ACTIVE_PER_SESSION; index += 1) {
                active.push(taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: `ping ${index}`, intervalMs: 60_000, startAt: Date.now() + HOUR })))
            }
            const changesBefore = h.events.length

            expect(h.engine.updateSessionTask(h.session.id, paused.id, { paused: false })).toEqual({ type: 'too-many-tasks' })
            expect(h.engine.updateSessionTask(h.session.id, paused.id, { paused: false, intervalMs: 120_000 })).toEqual({ type: 'too-many-tasks' })
            expect(h.engine.runSessionTaskNow(h.session.id, paused.id)).toEqual({ type: 'too-many-tasks' })
            // Nothing was applied, announced or run.
            expect(h.engine.listSessionTasks(h.session.id).find((row) => row.id === paused.id)).toMatchObject({ state: 'paused', nextRunAt: null, intervalMs: 60_000 })
            expect(h.events).toHaveLength(changesBefore)
            await settle()
            expect(h.sent).toEqual([])

            // One of the others goes: the resume fits.
            await h.engine.deleteSessionTask(h.session.id, active[0].id)
            expect(taskOf(h.engine.updateSessionTask(h.session.id, paused.id, { paused: false })).state).toBe('active')
        })

        it('refuses fields that do not apply to the task kind', () => {
            const h = harness()
            const queue = createLater(h, { kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000 })
            const repeat = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

            expect(h.engine.updateSessionTask(h.session.id, queue.id, { text: 'nope' })).toEqual({ type: 'wrong-task-kind', fields: ['text'] })
            expect(h.engine.updateSessionTask(h.session.id, queue.id, { maxRuns: null })).toEqual({ type: 'wrong-task-kind', fields: ['maxRuns'] })
            expect(h.engine.updateSessionTask(h.session.id, repeat.id, { items: [{ text: 'nope' }] })).toEqual({ type: 'wrong-task-kind', fields: ['items'] })
            // Nothing was applied, nothing announced.
            expect(h.engine.listSessionTasks(h.session.id).find((row) => row.id === queue.id)?.items).toEqual([{ text: 'a' }])
            expect(h.events.filter((event) => event.type === 'session-tasks-changed')).toHaveLength(2)
        })

        it('refuses a run limit below what already ran; equal ends the task once the pending prompt is taken', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, maxRuns: 5 }))
            await settle()
            h.store.messages.markMessagesInvoked(h.session.id, [h.sent[0].localId], Date.now())
            tick(h.engine)
            await settle()
            expect(h.engine.runSessionTaskNow(h.session.id, task.id).type).toBe('queued')
            await settle()
            expect(h.sent).toHaveLength(2)

            expect(h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: 1 })).toEqual({ type: 'invalid-max-runs' })
            // Equal to what ran is allowed: with a prompt pending the task ends when it is taken.
            const trimmed = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: 2 }))
            expect(trimmed).toMatchObject({ maxRuns: 2, runCount: 2, pending: true, totalRuns: 2 })
            expect(h.engine.listSessionTasks(h.session.id)).toHaveLength(1)

            h.store.messages.markMessagesInvoked(h.session.id, [h.sent[1].localId], Date.now())
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
        })

        it('ends a task at once when the limit is brought down to what ran with nothing pending', () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, maxRuns: 5 }))
            const now = Date.now()
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:e:1', nextRunAt: now + 60_000, now })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: now + 1, now: now + 1 })

            const ended = taskOf(h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: 1 }))
            expect(ended).toMatchObject({ maxRuns: 1, runCount: 1, pending: false })
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })
        })

        it('removes the run limit with null', () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000, maxRuns: 2 })

            expect(taskOf(h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: null }))).toMatchObject({ maxRuns: null, totalRuns: null })
        })
    })

    describe('runSessionTaskNow', () => {
        it('makes a paused task active, clears its error and runs it now', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() + HOUR }))
            h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            h.store.sessionTasks.setError(task.id, 'session_archived', Date.now())
            const before = Date.now()

            const queued = taskOf(h.engine.runSessionTaskNow(h.session.id, task.id))
            expect(queued).toMatchObject({ state: 'active', lastError: null, runCount: 0 })
            expect(queued.nextRunAt).toBeGreaterThanOrEqual(before)
            expect(queued.nextRunAt).toBeLessThanOrEqual(Date.now())
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })
            await settle()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['ping'])
        })

        it('is refused while a prompt of the task is pending', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 }))
            await settle()
            expect(h.sent).toHaveLength(1)

            const refused = h.engine.runSessionTaskNow(h.session.id, task.id)
            expect(refused.type).toBe('prompt-pending')
            expect(taskOf(refused)).toMatchObject({ pending: true, runCount: 1 })
            await settle()
            expect(h.sent).toHaveLength(1)
        })

        it('answers not-found for a task that is not in this session', () => {
            const h = harness()
            expect(h.engine.runSessionTaskNow(h.session.id, 'missing')).toEqual({ type: 'not-found' })
        })
    })

    describe('deleteSessionTask', () => {
        async function pendingQueue(h: Harness): Promise<SessionTask> {
            const task = taskOf(h.engine.createSessionTask(h.session.id, {
                kind: 'queue',
                items: [{ text: 'a' }, { text: 'b' }],
                intervalMs: 60_000
            }))
            await settle()
            return task
        }

        it('cancels a prompt the agent has not taken yet', async () => {
            const h = harness()
            const task = await pendingQueue(h)
            const cancelled: Array<{ sessionId: string; localId: string }> = []
            ;(h.engine as unknown as { cancelQueuedMessage: (id: string, localId: string) => Promise<unknown> }).cancelQueuedMessage = async (id, localId) => {
                cancelled.push({ sessionId: id, localId })
                h.store.messages.deleteQueuedMessageById(id, localId)
                return { status: 'cancelled', localId }
            }

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'cancelled' })
            expect(cancelled).toEqual([{ sessionId: h.session.id, localId: `${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}${task.id}:1` }])
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
            expect(h.engine.listSessionTaskRuns(h.session.id, 50).map((run) => run.outcome)).toEqual(['cancelled'])
        })

        it('answers taken when the agent got the prompt first', async () => {
            const h = harness()
            const task = await pendingQueue(h)
            ;(h.engine as unknown as { cancelQueuedMessage: () => Promise<unknown> }).cancelQueuedMessage = async () => ({ status: 'invoked', message: { invokedAt: 123 } })

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'taken' })
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
            expect(h.engine.listSessionTaskRuns(h.session.id, 50)[0]?.takenAt).not.toBeNull()
        })

        it('answers unconfirmed and still deletes when the cancel cannot be confirmed', async () => {
            const h = harness()
            const task = await pendingQueue(h)
            ;(h.engine as unknown as { cancelQueuedMessage: () => Promise<unknown> }).cancelQueuedMessage = async () => ({ status: 'busy', localId: 'x' })

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'unconfirmed' })
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
            // Whether the agent takes it is unknown: the history line stays a waiting send.
            expect(h.engine.listSessionTaskRuns(h.session.id, 50).map((run) => [run.outcome, run.takenAt])).toEqual([['sent', null]])
        })

        it('answers unconfirmed when cancelling the pending prompt throws', async () => {
            const h = harness()
            const task = await pendingQueue(h)
            const warn = mock(() => undefined)
            const originalWarn = console.warn
            console.warn = warn
            try {
                ;(h.engine as unknown as { cancelQueuedMessage: () => Promise<unknown> }).cancelQueuedMessage = async () => {
                    throw new Error('CLI offline')
                }
                await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'unconfirmed' })
            } finally {
                console.warn = originalWarn
            }
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
        })

        it('answers none when there was no pending prompt', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() + HOUR }))
            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'none' })
        })

        it('answers not-found for a task that is not in this session', async () => {
            const h = harness()
            await expect(h.engine.deleteSessionTask(h.session.id, 'missing')).resolves.toEqual({ type: 'not-found' })
        })

        it('forgets the wake count of the pending prompt it cancels', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 }))
            await settle()
            const runner = (h.engine as unknown as { sessionTaskRunner: { forgetPrompt: (pendingLocalId: string | null) => void } }).sessionTaskRunner
            const forgetPrompt = mock((_pendingLocalId: string | null) => undefined)
            runner.forgetPrompt = forgetPrompt

            await h.engine.deleteSessionTask(h.session.id, task.id)
            expect(h.cancelled).toEqual([{ sessionId: h.session.id, localId: h.sent[0].localId }])
            expect(forgetPrompt).toHaveBeenCalledTimes(1)
            expect(forgetPrompt).toHaveBeenCalledWith(h.sent[0].localId)
        })
    })

    describe('a pending prompt the agent did not take', () => {
        /** The agent exits with the prompt still queued; each resume brings the session up, and it exits again. */
        function stubResume(h: Harness): string[] {
            const resumes: string[] = []
            ;(h.engine as unknown as { resumeSession: (id: string) => Promise<unknown> }).resumeSession = async (id) => {
                resumes.push(id)
                h.session.active = true
                return { type: 'success', sessionId: id }
            }
            return resumes
        }

        it('wakes the session again after an explicit resume instead of answering prompt_not_taken at once', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 }))
            await settle()
            expect(h.sent).toHaveLength(1)
            const resumes = stubResume(h)

            h.session.active = false
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                h.session.active = false
                tick(h.engine)
                await settle()
                expect(resumes).toHaveLength(attempt)
            }
            h.session.active = false
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ lastError: 'prompt_not_taken', pending: true })
            expect(resumes).toHaveLength(3)

            // The user pauses and resumes to make the hub try again: the count starts over and the error stays gone.
            h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            expect(taskOf(h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))).toMatchObject({ state: 'active', nextRunAt: null, lastError: null, pending: true })
            await settle()
            expect(resumes).toHaveLength(4)
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ lastError: null, pending: true })

            // Three more wakes without a take end the same way.
            for (let attempt = 0; attempt < 2; attempt += 1) {
                h.session.active = false
                tick(h.engine)
                await settle()
            }
            expect(resumes).toHaveLength(6)
            expect(h.engine.listSessionTasks(h.session.id)[0]?.lastError).toBeNull()
            h.session.active = false
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ lastError: 'prompt_not_taken' })
            expect(resumes).toHaveLength(6)
        })
    })

    it('lists the run history newest first', async () => {
        const h = harness()
        const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000 }))
        await settle()
        h.store.sessionTasks.recordRun({ sessionId: h.session.id, taskId: task.id, taskKind: 'queue', runNumber: null, outcome: 'failed', scheduledFor: null, detail: 'send_failed' }, Date.now())

        const runs = h.engine.listSessionTaskRuns(h.session.id, 50)
        expect(runs.map((run) => [run.outcome, run.detail, run.taskId])).toEqual([['failed', 'send_failed', task.id], ['sent', null, task.id]])
        expect(runs[1]).toMatchObject({ sessionId: h.session.id, taskKind: 'queue', runNumber: 1, preview: 'a' })
        expect(h.engine.listSessionTaskRuns(h.session.id, 1)).toHaveLength(1)
    })

    it('runs due tasks on the tick even when nothing scheduled came due', async () => {
        const h = harness()
        h.internals.messageService = { releaseMatureScheduledMessages: () => [] }
        // Inserted by another client between ticks.
        h.store.sessionTasks.create({
            sessionId: h.session.id,
            kind: 'repeat',
            items: ['ping'],
            intervalMs: 60_000,
            maxRuns: null,
            startAt: Date.now() - 1,
            nextRunAt: Date.now() - 1
        })

        tick(h.engine)
        await settle()
        expect(h.sent).toHaveLength(1)
    })

    it('neither releases scheduled messages into nor wakes an archived session', async () => {
        const h = harness('archived')
        const archived = makeSession(h.store, 'archived-session', { lifecycleState: 'archived' })
        h.sessions.set(archived.id, { ...archived, active: false, metadata: { lifecycleState: 'archived' } })
        const held: Array<ReadonlySet<string>> = []
        h.internals.messageService = {
            releaseMatureScheduledMessages: (_now: number, skip: ReadonlySet<string>) => {
                held.push(skip)
                return [archived.id]
            }
        }
        const resumeCalls: string[] = []
        ;(h.engine as unknown as { resumeSession: (id: string) => Promise<unknown> }).resumeSession = async (id) => {
            resumeCalls.push(id)
            return { type: 'success', sessionId: id }
        }
        h.engine.createSessionTask(archived.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

        tick(h.engine)
        await settle()
        expect(held).toHaveLength(1)
        expect(held[0].has(archived.id)).toBe(true)
        expect(resumeCalls).toEqual([])
        expect(h.sent).toEqual([])
        // The task stays due and says why; it is not paused.
        expect(h.engine.listSessionTasks(archived.id)[0]).toMatchObject({ state: 'active', lastError: 'session_archived' })

        // Un-archived (and opened, so it is running): the next tick sends the prompt.
        h.sessions.set(archived.id, { ...archived, active: true, metadata: { lifecycleState: 'running' } })
        tick(h.engine)
        await settle()
        expect(h.sent.map((prompt) => prompt.text)).toEqual(['ping'])
        expect(h.engine.listSessionTasks(archived.id)[0]).toMatchObject({ lastError: null, runCount: 1 })
    })
})
