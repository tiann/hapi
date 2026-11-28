import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
    SESSION_TASK_MAX_ACTIVE_PER_SESSION,
    SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX,
    type CreateSessionTaskRequest,
    type SessionTask
} from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store, type CancelQueuedMessageOptions, type CancelQueuedMessageResult } from '../store'
import { SESSION_TASK_RUN_CANCEL_UNCONFIRMED } from '../store/sessionTasks'
import type { StoredMessage } from '../store/types'
import type { CliCancelAckResult } from './messageService'
import { SESSION_TASK_CANCEL_FOLLOW_UP_MS, SyncEngine } from './syncEngine'

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
    /** The toasts the engine sends (what a user is told when the hub itself finds something out). */
    const toasts: Array<{ namespace: string } & Record<string, unknown>> = []
    internals.eventPublisher = {
        emit: (event: SyncEvent) => { events.push(event) },
        sendToast: (namespace: string, event: { data: Record<string, unknown> }) => {
            toasts.push({ namespace, ...event.data })
            return Promise.resolve(1)
        }
    }
    internals.openCodeRewindPending = () => false
    internals.reconcileOpenCodeClears = async () => undefined
    internals.reconcileDerivedToolWork = () => undefined
    // The 5s tick asks for mature scheduled messages; none in these tests.
    internals.messageService = { releaseMatureScheduledMessages: () => [] }
    return { engine, events, internals, toasts }
}

function makeSession(store: Store, tag: string, metadata?: Record<string, unknown>): FakeSession {
    const id = store.sessions.getOrCreateSession(tag, { path: '/tmp', flavor: 'cursor', ...metadata }, null, 'default').id
    return { id, namespace: 'default', active: true }
}

function harness(tag = 'tasks') {
    const store = new Store(':memory:')
    const session = makeSession(store, tag)
    const sessions = new Map<string, FakeSession>([[session.id, session]])
    const { engine, events, internals, toasts } = stubEngine(store, sessions)
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
    /** The options each cancel was called with: the probe budget a task's cancel asks for. */
    const cancelOptions: Array<CancelQueuedMessageOptions | undefined> = []
    ;(engine as unknown as { cancelQueuedMessage: (id: string, localId: string, options?: CancelQueuedMessageOptions) => Promise<unknown> }).cancelQueuedMessage = async (id, localId, options) => {
        cancelled.push({ sessionId: id, localId })
        cancelOptions.push(options)
        store.messages.deleteQueuedMessageById(id, localId)
        return { status: 'cancelled', localId }
    }
    return { store, session, sessions, engine, events, internals, sent, cancelled, cancelOptions, toasts }
}

/** A test's own stand-in for `SyncEngine.cancelQueuedMessage` (the harness installs one that confirms). */
type CancelStub = (id: string, localId: string, options?: CancelQueuedMessageOptions) => Promise<CancelQueuedMessageResult>
const setCancel = (h: Harness, stub: CancelStub): void => {
    ;(h.engine as unknown as { cancelQueuedMessage: CancelStub }).cancelQueuedMessage = stub
}

/**
 * The message service as the cancel follow-up sees it: whether a CLI socket
 * is in the session's room, and what it answers a cancel probe with.
 */
function withCliSocket(h: Harness, answer: CliCancelAckResult = 'removed') {
    const cli = { connected: false, answer, probes: [] as Array<[string, string, string, number]> }
    Object.assign(h.internals.messageService as object, {
        hasCliSocket: (sessionId: string) => cli.connected,
        requestCliCancelAck: async (sessionId: string, localId: string, messageId: string, timeoutMs: number) => {
            cli.probes.push([sessionId, localId, messageId, timeoutMs])
            return cli.answer
        }
    })
    return cli
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

    it('creates a repeat task with its first run at startAt and announces the change', async () => {
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

    it('clamps a first run that is already past to now', async () => {
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

    it(`answers too-many-tasks at ${SESSION_TASK_MAX_ACTIVE_PER_SESSION} active tasks, not counting paused ones`, async () => {
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
        await h.engine.updateSessionTask(h.session.id, paused.id, { paused: true })
        expect(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000 }).type).toBe('created')
    })

    it('summarizes the active tasks of the listed sessions', async () => {
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

        it('pause clears the schedule and the stored error', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            h.store.sessionTasks.setError(task.id, 'machine_offline', Date.now())

            const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))
            expect(paused).toMatchObject({ state: 'paused', nextRunAt: null, lastError: null })
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })
        })

        it('resume runs a task with nothing pending now', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() - 1_000 }))
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            const before = Date.now()

            const resumed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed.state).toBe('active')
            expect(resumed.nextRunAt).toBeGreaterThanOrEqual(before)
            await settle()
            expect(h.sent).toHaveLength(1)
        })

        it('resume keeps the first run of a task that has not run yet', async () => {
            const h = harness()
            const startAt = Date.now() + 2 * HOUR
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000, startAt }))
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })

            const resumed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed).toMatchObject({ state: 'active', startAt })
            expect(resumed.nextRunAt).toBe(startAt)
            await settle()
            expect(h.sent).toEqual([])
        })

        it('resume keeps a queue task spaced from when its last prompt was taken', async () => {
            const h = harness()
            const now = Date.now()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 30 * 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:x:1', nextRunAt: null, now })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: now - 5 * 60_000, nextRunAt: now + 25 * 60_000, now })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, now)

            // Paused for a moment: the rest of the spacing is kept.
            expect(taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false })).nextRunAt).toBe(now + 25 * 60_000)
        })

        it('resume runs a queue task whose spacing elapsed while it was paused', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 30 * 60_000 })
            const takenAt = Date.now() - 3 * HOUR
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:x:1', nextRunAt: null, now: takenAt })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: takenAt, nextRunAt: takenAt + 30 * 60_000, now: takenAt })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, takenAt + 1000)
            const before = Date.now()

            expect(taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false })).nextRunAt).toBeGreaterThanOrEqual(before)
        })

        it('resume leaves a queue task unscheduled while its prompt is still pending', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:y:1', nextRunAt: null, now: Date.now() })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, Date.now())

            const resumed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed).toMatchObject({ state: 'active', nextRunAt: null, pending: true })
        })

        it('leaves the schedule of a task that is already running alone', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

            const untouched = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(untouched.nextRunAt).toBe(task.nextRunAt)
            await settle()
            expect(h.sent).toEqual([])
        })

        it('returns not-found for a task that is not in this session', async () => {
            const h = harness()
            createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            expect(await h.engine.updateSessionTask(h.session.id, 'missing', { paused: true })).toEqual({ type: 'not-found' })
        })

        it('replaces the prompt of a repeat task', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

            const edited = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { text: 'pong' }))
            expect(edited.items).toEqual([{ text: 'pong' }])
            expect(edited).toMatchObject({ nextRunAt: task.nextRunAt, state: 'active' })
        })

        it('replaces the prompts a queue has not sent yet and keeps the ones it has', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], intervalMs: 60_000 }))
            await settle()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['a'])

            const edited = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { items: [{ text: 'x' }, { text: 'y' }] }))
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

        it('re-anchors a task with nothing pending to one interval from now', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            const before = Date.now()

            const edited = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { intervalMs: 10 * 60_000 }))
            expect(edited.intervalMs).toBe(10 * 60_000)
            // Nothing has run yet: the first run stays where it was put.
            expect(edited.nextRunAt).toBe(task.nextRunAt)

            // A task that has run, with nothing pending, moves its next run.
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:r:1', nextRunAt: before + 60_000, now: before })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: before + 1, now: before + 1 })
            const reAnchored = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { intervalMs: 10 * 60_000 }))
            expect(reAnchored.nextRunAt).toBeGreaterThanOrEqual(before + 10 * 60_000)
            expect(reAnchored.nextRunAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
        })

        it('re-anchors a resumed task to one new interval from now', async () => {
            const h = harness()
            const now = Date.now()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:ra:1', nextRunAt: now + 60_000, now })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: now, now })
            h.store.sessionTasks.update(task.id, { state: { paused: true, nextRunAt: null } }, now)

            const resumed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false, intervalMs: 10 * 60_000 }))
            expect(resumed).toMatchObject({ state: 'active', intervalMs: 10 * 60_000 })
            expect(resumed.nextRunAt).toBeGreaterThanOrEqual(now + 10 * 60_000)
            expect(resumed.nextRunAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
        })

        it('keeps the pause when the same request re-anchors the task', async () => {
            const h = harness()
            const now = Date.now()
            /** A task that has run once, with its prompt taken: nothing is pending. */
            function afterOneRun(request: CreateSessionTaskRequest) {
                const task = createLater(h, request)
                const queue = task.kind === 'queue'
                // As the runner does it: a repeat task keeps its grid on the send, a queue task is scheduled at the acknowledgement.
                h.store.sessionTasks.markSent(task.id, { localId: `hapi-task:${task.id}:1`, nextRunAt: queue ? null : now + 60_000, now })
                h.store.sessionTasks.settlePending(task.id, { consumedAt: now, nextRunAt: queue ? now + 60_000 : undefined, now })
                return task
            }
            const repeat = afterOneRun({ kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            const queue = afterOneRun({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 })

            // Pausing and changing the interval in one request: the task cannot run
            // after it, so there is nothing to re-anchor and the pause stays.
            for (const task of [repeat, queue]) {
                const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true, intervalMs: 120_000 }))
                expect(paused).toMatchObject({ id: task.id, state: 'paused', nextRunAt: null, intervalMs: 120_000, runCount: 1, pending: false })
            }
            // The same request on a task that is paused already only changes the interval.
            const edited = taskOf(await h.engine.updateSessionTask(h.session.id, repeat.id, { paused: true, intervalMs: 180_000 }))
            expect(edited).toMatchObject({ state: 'paused', nextRunAt: null, intervalMs: 180_000 })
            await settle()
            expect(h.sent).toEqual([])
        })

        it('does not resume a paused task when only its interval is edited', async () => {
            const h = harness()
            const now = Date.now()
            /** A task that has run once, with its prompt taken, and is now paused. */
            async function pausedAfterOneRun(request: CreateSessionTaskRequest) {
                const task = createLater(h, request)
                h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:interval:1', nextRunAt: null, now })
                h.store.sessionTasks.settlePending(task.id, { consumedAt: now + 1, nextRunAt: now + 60_000, now: now + 1 })
                expect(taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))).toMatchObject({ state: 'paused', runCount: 1, pending: false })
                return task
            }
            const repeat = await pausedAfterOneRun({ kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            const queue = await pausedAfterOneRun({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 })

            // An edit form that submits only the changed field must not start an unattended sender again.
            for (const task of [repeat, queue]) {
                const edited = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { intervalMs: 10 * 60_000 }))
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
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })

            const ended = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false, maxRuns: 3 }))
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
            await h.engine.updateSessionTask(h.session.id, paused.id, { paused: true })
            const active: SessionTask[] = []
            for (let index = active.length; index < SESSION_TASK_MAX_ACTIVE_PER_SESSION; index += 1) {
                active.push(taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: `ping ${index}`, intervalMs: 60_000, startAt: Date.now() + HOUR })))
            }
            const changesBefore = h.events.length

            expect(await h.engine.updateSessionTask(h.session.id, paused.id, { paused: false })).toEqual({ type: 'too-many-tasks' })
            expect(await h.engine.updateSessionTask(h.session.id, paused.id, { paused: false, intervalMs: 120_000 })).toEqual({ type: 'too-many-tasks' })
            expect(h.engine.runSessionTaskNow(h.session.id, paused.id)).toEqual({ type: 'too-many-tasks' })
            // Nothing was applied, announced or run.
            expect(h.engine.listSessionTasks(h.session.id).find((row) => row.id === paused.id)).toMatchObject({ state: 'paused', nextRunAt: null, intervalMs: 60_000 })
            expect(h.events).toHaveLength(changesBefore)
            await settle()
            expect(h.sent).toEqual([])

            // One of the others goes: the resume fits.
            await h.engine.deleteSessionTask(h.session.id, active[0].id)
            expect(taskOf(await h.engine.updateSessionTask(h.session.id, paused.id, { paused: false })).state).toBe('active')
        })

        /** Fill the session up to the cap with active tasks that run in an hour. */
        function fillSession(h: Harness): void {
            for (let index = 0; index < SESSION_TASK_MAX_ACTIVE_PER_SESSION; index += 1) {
                h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: `ping ${index}`, intervalMs: 60_000, startAt: Date.now() + HOUR })
            }
            expect(h.engine.getSessionTaskSummaries([h.session.id]).get(h.session.id)?.activeTaskCount).toBe(SESSION_TASK_MAX_ACTIVE_PER_SESSION)
        }

        it('lets a resume that ends the task at once into a session that holds the cap', async () => {
            const h = harness()
            const paused = createLater(h, { kind: 'repeat', text: 'paused', intervalMs: 60_000, maxRuns: 5 })
            const now = Date.now()
            for (let run = 1; run <= 3; run += 1) {
                h.store.sessionTasks.markSent(paused.id, { localId: `hapi-task:cap:${run}`, nextRunAt: now + 60_000, now })
                h.store.sessionTasks.settlePending(paused.id, { consumedAt: now + run, now: now + run })
            }
            await h.engine.updateSessionTask(h.session.id, paused.id, { paused: true })
            fillSession(h)

            // The limit comes down to what already ran: the task is over the moment it is
            // resumed, so it is never the 21st active task.
            const ended = taskOf(await h.engine.updateSessionTask(h.session.id, paused.id, { paused: false, maxRuns: 3 }))
            expect(ended).toMatchObject({ state: 'active', maxRuns: 3, runCount: 3, pending: false })
            expect(h.engine.listSessionTasks(h.session.id).some((row) => row.id === paused.id)).toBe(false)
            expect(h.engine.getSessionTaskSummaries([h.session.id]).get(h.session.id)?.activeTaskCount).toBe(SESSION_TASK_MAX_ACTIVE_PER_SESSION)
            await settle()
            expect(h.sent).toEqual([])
        })

        it('still refuses a resume into a full session when the task ends only once its pending prompt is taken', async () => {
            const h = harness()
            const paused = createLater(h, { kind: 'repeat', text: 'paused', intervalMs: 60_000, maxRuns: 5 })
            const localId = 'hapi-task:cap:pending'
            h.store.sessionTasks.markSent(paused.id, { localId, nextRunAt: null, now: Date.now() })
            // The prompt is in the queue, where the scheduler finds it on the ticks the other creates kick.
            h.store.addMessageForCurrentSession(h.session.id, { role: 'user', content: { type: 'text', text: 'paused' }, meta: { sentFrom: 'webapp' } }, localId, null)
            // Paused while the CLI could not confirm the cancel: the prompt stayed pending.
            ;(h.engine as unknown as { cancelQueuedMessage: () => Promise<unknown> }).cancelQueuedMessage = async () => ({ status: 'busy', localId })
            await h.engine.updateSessionTask(h.session.id, paused.id, { paused: true })
            fillSession(h)

            // Active until the agent takes the prompt: it counts like any other resume.
            expect(await h.engine.updateSessionTask(h.session.id, paused.id, { paused: false, maxRuns: 1 })).toEqual({ type: 'too-many-tasks' })
            expect(h.engine.listSessionTasks(h.session.id).find((row) => row.id === paused.id)).toMatchObject({ state: 'paused', maxRuns: 5, pending: true })
        })

        it('edits a paused task while the session holds the cap, since nothing is resumed', async () => {
            const h = harness()
            const paused = createLater(h, { kind: 'repeat', text: 'paused', intervalMs: 60_000, maxRuns: 2 })
            await h.engine.updateSessionTask(h.session.id, paused.id, { paused: true })
            fillSession(h)

            const edited = taskOf(await h.engine.updateSessionTask(h.session.id, paused.id, { text: 'renamed', intervalMs: 120_000, maxRuns: null }))
            expect(edited).toMatchObject({ state: 'paused', nextRunAt: null, intervalMs: 120_000, maxRuns: null, items: [{ text: 'renamed' }] })
            await settle()
            expect(h.sent).toEqual([])
        })

        it('refuses fields that do not apply to the task kind', async () => {
            const h = harness()
            const queue = createLater(h, { kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000 })
            const repeat = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

            expect(await h.engine.updateSessionTask(h.session.id, queue.id, { text: 'nope' })).toEqual({ type: 'wrong-task-kind', fields: ['text'] })
            expect(await h.engine.updateSessionTask(h.session.id, queue.id, { maxRuns: null })).toEqual({ type: 'wrong-task-kind', fields: ['maxRuns'] })
            expect(await h.engine.updateSessionTask(h.session.id, repeat.id, { items: [{ text: 'nope' }] })).toEqual({ type: 'wrong-task-kind', fields: ['items'] })
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

            expect(await h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: 1 })).toEqual({ type: 'invalid-max-runs' })
            // Equal to what ran is allowed: with a prompt pending the task ends when it is taken.
            const trimmed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: 2 }))
            expect(trimmed).toMatchObject({ maxRuns: 2, runCount: 2, pending: true, totalRuns: 2 })
            expect(h.engine.listSessionTasks(h.session.id)).toHaveLength(1)

            h.store.messages.markMessagesInvoked(h.session.id, [h.sent[1].localId], Date.now())
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
        })

        it('ends a task at once when the limit is brought down to what ran with nothing pending', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, maxRuns: 5 }))
            const now = Date.now()
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:e:1', nextRunAt: now + 60_000, now })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: now + 1, now: now + 1 })

            const ended = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: 1 }))
            expect(ended).toMatchObject({ maxRuns: 1, runCount: 1, pending: false })
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })
        })

        it('removes the run limit with null', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000, maxRuns: 2 })

            expect(taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { maxRuns: null }))).toMatchObject({ maxRuns: null, totalRuns: null })
        })
    })

    describe('runSessionTaskNow', () => {
        it('makes a paused task active, clears its error and runs it now', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() + HOUR }))
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
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

        it('answers not-found for a task that is not in this session', async () => {
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

            // The user pauses and resumes to make the hub try again. The CLI could not confirm the
            // cancel, so the prompt stayed pending through the pause: the count starts over and
            // the error stays gone.
            const localId = h.sent[0].localId
            ;(h.engine as unknown as { cancelQueuedMessage: (id: string, localId: string) => Promise<unknown> }).cancelQueuedMessage = async () => ({ status: 'busy', localId })
            expect(taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))).toMatchObject({ state: 'paused', nextRunAt: null, pending: true, runCount: 1 })
            expect(taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))).toMatchObject({ state: 'active', nextRunAt: null, lastError: null, pending: true })
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

    describe('a cancel the CLI must confirm', () => {
        /** [outcome, takenAt set?, detail] of the task's run rows, oldest first. */
        const runsOf = (h: Harness, localId: string) => h.store.sessionTasks.listRuns(h.session.id, 50)
            .filter((run) => run.localId === localId)
            .map((run) => [run.outcome, run.takenAt !== null, run.detail])

        async function pendingPrompt(h: Harness, request: CreateSessionTaskRequest = { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 }) {
            const task = taskOf(h.engine.createSessionTask(h.session.id, request))
            await settle()
            const prompts = h.sent.filter((prompt) => prompt.localId.startsWith(`${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}${task.id}:`))
            expect(prompts).toHaveLength(1)
            return { task, localId: prompts[0].localId }
        }

        it('waits for a slow CLI: the probe gets the patient budget and the answer is cancelled', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            // A CLI that answers after 900 ms: within the task's budget, past the bar's 500 ms.
            setCancel(h, async (id, prompt, options) => {
                h.cancelOptions.push(options)
                if (options?.probeTimeoutMs !== 3000) return { status: 'busy', localId: prompt }
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt }
            })

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'cancelled' })
            expect(h.cancelOptions).toEqual([{ probeTimeoutMs: 3000 }])
            expect(h.store.messages.lookupQueuedMessage(h.session.id, localId).status).toBe('absent')
            expect(runsOf(h, localId)).toEqual([['cancelled', false, null]])
        })

        it('with no CLI socket answers cancelled, marks the run row, and asks the CLI again once it is in the room', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'removed')
            setCancel(h, async (id, prompt) => {
                h.cancelOptions.push(undefined)
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'cancelled' })
            expect(runsOf(h, localId)).toEqual([['cancelled', false, SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])
            const eventsBefore = h.events.length

            // No CLI in the room: nothing to ask.
            tick(h.engine)
            await settle()
            expect(cli.probes).toEqual([])

            cli.connected = true
            tick(h.engine)
            await settle()
            expect(cli.probes).toEqual([[h.session.id, localId, localId, 2000]])
            expect(runsOf(h, localId)).toEqual([['cancelled', false, null]])
            expect(h.events.slice(eventsBefore)).toEqual([{ type: 'session-tasks-changed', sessionId: h.session.id }])

            // Settled: the next tick asks nothing more.
            tick(h.engine)
            await settle()
            expect(cli.probes).toHaveLength(1)
        })

        it('clears the marker on not-found as well', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'not-found')
            setCancel(h, async (id, prompt) => {
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })
            await h.engine.deleteSessionTask(h.session.id, task.id)
            cli.connected = true

            tick(h.engine)
            await settle()
            expect(runsOf(h, localId)).toEqual([['cancelled', false, null]])
        })

        it('flips the row to sent when the CLI reports the prompt was taken after all', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'consumed')
            setCancel(h, async (id, prompt) => {
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })
            await h.engine.deleteSessionTask(h.session.id, task.id)
            cli.connected = true

            tick(h.engine)
            await settle()
            expect(runsOf(h, localId)).toEqual([['sent', true, null]])
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).find((run) => run.localId === localId)?.takenAt).toBeGreaterThan(0)
            // The user believed that prompt cancelled: say that the agent got it after all.
            expect(h.toasts).toEqual([{
                namespace: 'default',
                title: 'Deleted task prompt was taken',
                body: 'A prompt of a task you deleted reached the agent after all: its process still held the copy when the task was deleted. Check the session.',
                sessionId: h.session.id,
                url: `/sessions/${h.session.id}`
            }])
        })

        it('the two minutes count from the first tick on which a CLI is in the room', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'removed')
            setCancel(h, async (id, prompt) => {
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })
            await h.engine.deleteSessionTask(h.session.id, task.id)

            // An hour with no CLI in the room: nothing is given up, the row keeps its marker.
            const realNow = Date.now
            try {
                Date.now = () => realNow() + HOUR
                tick(h.engine)
                await settle()
                expect(cli.probes).toEqual([])
                expect(runsOf(h, localId)).toEqual([['cancelled', false, SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])

                // The CLI comes back, however late: asked, and settled.
                cli.connected = true
                tick(h.engine)
                await settle()
            } finally {
                Date.now = realNow
            }
            expect(cli.probes).toHaveLength(1)
            expect(runsOf(h, localId)).toEqual([['cancelled', false, null]])
        })

        it('forgets a prompt whose session is gone', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'removed')
            cli.connected = true
            setCancel(h, async (id, prompt) => {
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })
            await h.engine.deleteSessionTask(h.session.id, task.id)
            // The session is deleted: its rows and the process that could hold the prompt go with it.
            ;(h.store as unknown as { db: { exec(sql: string): void } }).db.exec(`DELETE FROM sessions WHERE id = '${h.session.id}'`)

            tick(h.engine)
            await settle()
            expect(cli.probes).toEqual([])
        })

        it('a prompt the runner took back before its send was counted gets a run row, so the ask outlives a restart', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000, startAt: Date.now() + HOUR }))
            await settle()
            const localId = `${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}${task.id}:1`
            const cli = withCliSocket(h, 'removed')
            // The task was deleted while the insert was under way, and no CLI is in the room to ask.
            setCancel(h, async (id, prompt) => {
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })
            const stored = h.store.sessionTasks.getById(task.id)
            if (!stored) throw new Error('the task is missing')
            const takeBack = (h.engine as unknown as { takeBackUntrackedPrompt(task: unknown, sessionId: string, localId: string): Promise<void> }).takeBackUntrackedPrompt
            await takeBack.call(h.engine, stored, h.session.id, localId)
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.runNumber, run.outcome, run.detail, run.preview])).toEqual([
                [1, 'cancelled', SESSION_TASK_RUN_CANCEL_UNCONFIRMED, 'a']
            ])

            cli.connected = true
            tick(h.engine)
            await settle()
            expect(cli.probes).toEqual([[h.session.id, localId, localId, 2000]])
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => run.detail)).toEqual([null])
        })

        it('keeps asking on timeout, in-flight and indeterminate, and gives up after two minutes', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'timeout')
            setCancel(h, async (id, prompt) => {
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })
            await h.engine.deleteSessionTask(h.session.id, task.id)
            cli.connected = true

            for (const answer of ['timeout', 'in-flight', 'indeterminate'] as CliCancelAckResult[]) {
                cli.answer = answer
                tick(h.engine)
                await settle()
                expect(runsOf(h, localId)).toEqual([['cancelled', false, SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])
            }
            expect(cli.probes).toHaveLength(3)

            // Two minutes over: the row keeps its marker, nothing more is asked.
            const realNow = Date.now
            try {
                Date.now = () => realNow() + SESSION_TASK_CANCEL_FOLLOW_UP_MS + 1
                tick(h.engine)
                await settle()
                expect(cli.probes).toHaveLength(3)
            } finally {
                Date.now = realNow
            }
            expect(runsOf(h, localId)).toEqual([['cancelled', false, SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])

            // A CLI that answers 'consumed' in time ends it with the take instead.
            const other = await pendingPrompt(h, { kind: 'queue', items: [{ text: 'x' }], intervalMs: 60_000 })
            cli.answer = 'consumed'
            await h.engine.deleteSessionTask(h.session.id, other.task.id)
            tick(h.engine)
            await settle()
            expect(runsOf(h, other.localId)).toEqual([['sent', true, null]])
        })

        it('asks again through the ordinary cancel while the row is still there, and gives up on it the same way', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'removed')
            // The CLI did not answer the first cancel: the row stays indeterminate.
            setCancel(h, async (id, prompt) => {
                h.store.messages.setMessagesDeliveryState(id, [prompt], 'indeterminate')
                return { status: 'busy', localId: prompt }
            })

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'unconfirmed' })
            expect(runsOf(h, localId)).toEqual([['sent', false, SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])
            // The row is there, so the CLI is asked through the cancel, with the follow-up budget, not directly.
            cli.connected = true
            let optionsSeen: unknown = 'unset'
            setCancel(h, async (id, prompt, options) => {
                optionsSeen = options
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt }
            })

            tick(h.engine)
            await settle()
            expect(optionsSeen).toEqual({ probeTimeoutMs: 2000 })
            expect(cli.probes).toEqual([])
            expect(runsOf(h, localId)).toEqual([['cancelled', false, null]])

            // Busy again and again: the marker stays until the time is up.
            const other = await pendingPrompt(h, { kind: 'queue', items: [{ text: 'y' }], intervalMs: 60_000 })
            setCancel(h, async (id, prompt) => ({ status: 'busy', localId: prompt }))
            await h.engine.deleteSessionTask(h.session.id, other.task.id)
            const realNow = Date.now
            try {
                tick(h.engine)
                await settle()
                expect(runsOf(h, other.localId)).toEqual([['sent', false, SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])
                Date.now = () => realNow() + SESSION_TASK_CANCEL_FOLLOW_UP_MS + 1
                tick(h.engine)
                await settle()
            } finally {
                Date.now = realNow
            }
            expect(runsOf(h, other.localId)).toEqual([['sent', false, SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])
        })

        it('loads the list at engine start from the run rows that carry the marker', async () => {
            const h = harness()
            const task = taskOf(h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'z', intervalMs: 60_000, startAt: Date.now() + HOUR }))
            const localId = 'hapi-task:restart:1'
            h.store.sessionTasks.recordRun({
                sessionId: h.session.id, taskId: task.id, taskKind: 'repeat', runNumber: 1, localId, outcome: 'cancelled',
                scheduledFor: Date.now(), detail: SESSION_TASK_RUN_CANCEL_UNCONFIRMED
            }, Date.now())
            // A row that was settled since carries no marker: nothing is asked about it.
            h.store.sessionTasks.recordRun({
                sessionId: h.session.id, taskId: task.id, taskKind: 'repeat', runNumber: 2, localId: 'hapi-task:restart:2', outcome: 'cancelled', scheduledFor: Date.now()
            }, Date.now())

            // A new engine process on the same store.
            const { engine, events, internals } = stubEngine(h.store, h.sessions)
            const cli = { connected: true, probes: [] as Array<[string, string, string, number]> }
            Object.assign(internals.messageService as object, {
                hasCliSocket: () => cli.connected,
                requestCliCancelAck: async (sessionId: string, prompt: string, messageId: string, timeoutMs: number) => {
                    cli.probes.push([sessionId, prompt, messageId, timeoutMs])
                    return 'removed'
                }
            })
            const asked: string[] = []
            ;(engine as unknown as { cancelQueuedMessage: CancelStub }).cancelQueuedMessage = async (_id, prompt) => {
                asked.push(prompt)
                return { status: 'cancelled', localId: null }
            }
            const changes = events.filter((event) => event.type === 'session-tasks-changed').length

            tick(engine)
            await settle()
            expect(cli.probes).toEqual([[h.session.id, localId, localId, 2000]])
            expect(asked).toEqual([])
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.localId, run.detail])).toEqual([
                ['hapi-task:restart:2', null],
                [localId, null]
            ])
            expect(events.filter((event) => event.type === 'session-tasks-changed')).toHaveLength(changes + 1)
        })

        it('the queued-message bar\'s own cancel registers no follow-up', async () => {
            const h = harness()
            const { task, localId } = await pendingPrompt(h)
            const cli = withCliSocket(h, 'removed')
            cli.connected = true
            setCancel(h, async (id, prompt, options) => {
                h.cancelOptions.push(options)
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return { status: 'cancelled', localId: prompt, unconfirmed: true }
            })

            // The user cancels the prompt from the bar: the ordinary path, no task involved.
            await h.engine.cancelQueuedMessage(h.session.id, localId)
            expect(h.cancelOptions).toEqual([undefined])
            expect(runsOf(h, localId)).toEqual([['sent', false, null]])

            tick(h.engine)
            await settle()
            expect(cli.probes).toEqual([])
            // The runner settles the task on the row that is gone, as before.
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ pending: false, runCount: 1 })
            expect(runsOf(h, localId)).toEqual([['cancelled', false, null]])
        })
    })

    describe('pause takes the waiting prompt back', () => {
        /** A task whose first prompt is out and waiting. */
        async function pendingTask(
            h: Harness,
            request: CreateSessionTaskRequest = { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], intervalMs: 60_000 }
        ) {
            const task = taskOf(h.engine.createSessionTask(h.session.id, request))
            await settle()
            expect(h.sent).toHaveLength(1)
            return { task, localId: h.sent[0].localId as string }
        }

        it('pulls the prompt back when the CLI confirms: not pending, one send fewer, the run row cancelled; resume sends it again', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ runCount: 1, pending: true })

            const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))
            expect(paused).toMatchObject({ state: 'paused', nextRunAt: null, pending: false, runCount: 0, lastRunAt: null, lastError: null, totalRuns: 3 })
            expect(h.cancelled).toEqual([{ sessionId: h.session.id, localId }])
            expect(h.cancelOptions).toEqual([{ probeTimeoutMs: 3000 }])
            expect(h.store.messages.lookupQueuedMessage(h.session.id, localId).status).toBe('absent')
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.runNumber, run.outcome, run.takenAt, run.detail])).toEqual([[1, 'cancelled', null, null]])
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })

            // Nothing is pending and the task is paused: a tick changes nothing.
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'paused', runCount: 0, pending: false })

            // Resume: the queue sends that same prompt again, under the same localId.
            const resumed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed).toMatchObject({ state: 'active', runCount: 0, pending: false })
            await settle()
            expect(h.sent.map((prompt) => [prompt.text, prompt.localId])).toEqual([['a', localId], ['a', localId]])
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'active', runCount: 1, pending: true })
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.runNumber, run.outcome])).toEqual([[1, 'sent'], [1, 'cancelled']])
        })

        it('leaves the last run at the send that still counts', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            const firstTakenAt = Date.now()
            // Prompt 1 is taken; prompt 2 goes out and waits.
            h.store.messages.markMessagesInvoked(h.session.id, [localId], firstTakenAt)
            tick(h.engine)
            await settle()
            h.engine.runSessionTaskNow(h.session.id, task.id)
            await settle()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['a', 'b'])
            const second = h.sent[1].localId
            const firstRunAt = h.store.sessionTasks.listRuns(h.session.id, 50).find((run) => run.localId === localId)?.recordedAt

            const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))
            expect(paused).toMatchObject({ runCount: 1, pending: false, lastRunAt: firstRunAt })
            expect(h.store.sessionTasks.getById(task.id)?.lastConsumedAt).toBe(firstTakenAt)
            // Resume keeps the spacing from the take of the prompt that still counts.
            const resumed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed.nextRunAt).toBe(firstTakenAt + 60_000)
        })

        it('a prompt the agent already took stays counted', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            setCancel(h, async (id, prompt) => {
                h.store.messages.markMessagesInvoked(id, [prompt], 123)
                return { status: 'invoked', message: { invokedAt: 123 } as unknown as StoredMessage }
            })

            const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))
            expect(paused).toMatchObject({ state: 'paused', pending: true, runCount: 1 })
            expect(h.store.sessionTasks.listRuns(h.session.id, 50)[0]).toMatchObject({ outcome: 'sent', takenAt: 123 })
            // The runner settles it on its tick as before.
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'paused', pending: false, runCount: 1 })

            await h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            await settle()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['a', 'b'])
        })

        it('an unconfirmed pull-back leaves the prompt pending and registers no follow-up', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            const cli = withCliSocket(h, 'removed')
            setCancel(h, async (id, prompt) => {
                h.store.messages.setMessagesDeliveryState(id, [prompt], 'indeterminate')
                return { status: 'busy', localId: prompt }
            })

            const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))
            expect(paused).toMatchObject({ state: 'paused', nextRunAt: null, pending: true, runCount: 1 })
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.outcome, run.detail])).toEqual([['sent', null]])

            // The task still owns the prompt: no follow-up, with or without a CLI in the room.
            cli.connected = true
            tick(h.engine)
            await settle()
            expect(cli.probes).toEqual([])
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'paused', pending: true, runCount: 1, lastError: 'prompt_indeterminate' })
        })

        /** The hub removed its row itself (no CLI was in the room to ask). */
        const cancelWithNoCli = (h: Harness) => setCancel(h, async (id, prompt) => {
            h.store.messages.deleteQueuedMessageById(id, prompt)
            return { status: 'cancelled', localId: prompt, unconfirmed: true }
        })

        it('a pause with no CLI in the room takes the prompt back as well, and asks the CLI to drop its copy once it is there', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            const cli = withCliSocket(h, 'removed')
            cancelWithNoCli(h)

            const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true }))
            expect(paused).toMatchObject({ state: 'paused', pending: false, runCount: 0 })
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.outcome, run.detail])).toEqual([['cancelled', SESSION_TASK_RUN_CANCEL_UNCONFIRMED]])

            // However late the CLI comes back, it is asked then; until it answers the row keeps its marker.
            const realNow = Date.now
            try {
                Date.now = () => realNow() + 10 * 60_000
                tick(h.engine)
                await settle()
                expect(cli.probes).toEqual([])
                cli.connected = true
                tick(h.engine)
                await settle()
            } finally {
                Date.now = realNow
            }
            expect(cli.probes).toEqual([[h.session.id, localId, localId, 2000]])
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.outcome, run.detail])).toEqual([['cancelled', null]])

            // Resume sends that same prompt again, under the same localId.
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            await settle()
            expect(h.sent.map((prompt) => [prompt.text, prompt.localId])).toEqual([['a', localId], ['a', localId]])
            expect(h.toasts).toEqual([])
        })

        it('resumed before the CLI answered: the prompt goes out again only once the CLI has dropped its copy', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            const cli = withCliSocket(h, 'removed')
            cancelWithNoCli(h)
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            const resumed = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))
            expect(resumed).toMatchObject({ state: 'active', pending: false, runCount: 0 })
            await settle()
            // Due, but an earlier copy may still sit in the wrapper: sent now, the CLI would hold two copies
            // under one localId, and the ask about the first would drop them both.
            expect(h.sent).toHaveLength(1)
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'active', pending: false, runCount: 0 })

            cli.connected = true
            tick(h.engine)
            await settle()
            expect(cli.probes).toHaveLength(1)
            expect(h.sent.map((prompt) => [prompt.text, prompt.localId])).toEqual([['a', localId], ['a', localId]])
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'active', pending: true, runCount: 1 })
        })

        it('a CLI that then reports the agent took the prompt makes it count again, and the user hears of it', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            const cli = withCliSocket(h, 'consumed')
            cancelWithNoCli(h)
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })

            cli.connected = true
            tick(h.engine)
            await settle()
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.outcome, run.takenAt !== null, run.detail])).toEqual([['sent', true, null]])
            // The agent has that prompt: it counts again, so a resume goes on after it instead of sending it twice.
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'paused', pending: false, runCount: 1 })
            expect(h.toasts).toEqual([{
                namespace: 'default',
                title: 'Paused task prompt was taken',
                body: 'The prompt that was pulled back when you paused the task reached the agent after all: its process still held the copy. The task does not send it again.',
                sessionId: h.session.id,
                url: `/sessions/${h.session.id}`
            }])

            await h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            await settle()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['a', 'b'])
        })

        it('resumed, then found taken: the task goes on one interval after that take', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            const cli = withCliSocket(h, 'consumed')
            cancelWithNoCli(h)
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            await settle()
            expect(h.sent).toHaveLength(1)

            cli.connected = true
            const before = Date.now()
            tick(h.engine)
            await settle()
            const after = h.engine.listSessionTasks(h.session.id)[0]
            expect(after).toMatchObject({ state: 'active', pending: false, runCount: 1 })
            expect(after?.nextRunAt).toBeGreaterThanOrEqual(before + 60_000)
            expect(after?.nextRunAt).toBeLessThanOrEqual(Date.now() + 60_000)
            expect(h.sent).toHaveLength(1)
        })

        it('does not let the runner settle the task while the pull-back is in flight', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            let answer: (result: CancelQueuedMessageResult) => void = () => undefined
            setCancel(h, (_id, prompt) => new Promise((resolve) => {
                answer = resolve
                // The row goes while the CLI's answer is awaited.
                h.store.messages.deleteQueuedMessageById(h.session.id, prompt)
            }))

            const pausing = h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'paused', pending: true, runCount: 1 })
            // A tick in the middle: the runner must not settle the task on the row that is gone.
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'paused', pending: true, runCount: 1 })
            expect(h.store.sessionTasks.listRuns(h.session.id, 50)[0]?.outcome).toBe('sent')

            answer({ status: 'cancelled', localId })
            expect(taskOf(await pausing)).toMatchObject({ state: 'paused', pending: false, runCount: 0 })
            // Released: ticks run again (nothing to do here: the task is paused with nothing pending).
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'paused', pending: false, runCount: 0 })
        })

        it('a delete that lands while the pull-back is in flight wins: the pause answers not-found', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            let answer: (result: CancelQueuedMessageResult) => void = () => undefined
            let calls = 0
            setCancel(h, (id, prompt) => {
                calls += 1
                if (calls === 1) return new Promise((resolve) => { answer = resolve })
                h.store.messages.deleteQueuedMessageById(id, prompt)
                return Promise.resolve({ status: 'cancelled', localId: prompt })
            })

            const pausing = h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'cancelled' })
            answer({ status: 'cancelled', localId: null })
            await expect(pausing).resolves.toEqual({ type: 'not-found' })
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
            expect(h.store.sessionTasks.listRuns(h.session.id, 50).map((run) => [run.outcome, run.detail])).toEqual([['cancelled', null]])
        })

        it('a resume that lands while the pull-back is in flight runs the task once the prompt is back', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            let answer: (result: CancelQueuedMessageResult) => void = () => undefined
            setCancel(h, (_id, prompt) => new Promise((resolve) => {
                answer = resolve
                h.store.messages.deleteQueuedMessageById(h.session.id, prompt)
            }))

            const pausing = h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            expect(taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: false }))).toMatchObject({ state: 'active', pending: true, nextRunAt: null })
            answer({ status: 'cancelled', localId })
            const before = Date.now()
            const result = taskOf(await pausing)
            expect(result).toMatchObject({ state: 'active', pending: false, runCount: 0 })
            expect(result.nextRunAt).toBeGreaterThanOrEqual(before - 1)
            expect(result.nextRunAt).toBeLessThanOrEqual(Date.now())

            await settle()
            expect(h.sent.map((prompt) => [prompt.text, prompt.localId])).toEqual([['a', localId], ['a', localId]])
        })

        it('a limit equal to what ran, paused with the prompt waiting, leaves one prompt to send on resume', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h, { kind: 'repeat', text: 'r', intervalMs: 60_000, maxRuns: 1 })
            const paused = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true, maxRuns: 1 }))
            // Validated against the old count, applied to the new one: not ended, one run left.
            expect(paused).toMatchObject({ state: 'paused', maxRuns: 1, totalRuns: 1, runCount: 0, pending: false })
            expect(h.engine.listSessionTasks(h.session.id)).toHaveLength(1)

            await h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)[0]).toMatchObject({ state: 'active', runCount: 1, pending: true, maxRuns: 1 })
            // Taken: the limit is reached and the task ends.
            h.store.messages.markMessagesInvoked(h.session.id, [localId], Date.now())
            tick(h.engine)
            await settle()
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
        })

        it('a task that is paused already keeps its prompt pending', async () => {
            const h = harness()
            const { task, localId } = await pendingTask(h)
            let asked = 0
            setCancel(h, async () => {
                asked += 1
                return { status: 'busy', localId }
            })
            await h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            expect(asked).toBe(1)

            const again = taskOf(await h.engine.updateSessionTask(h.session.id, task.id, { paused: true, intervalMs: 120_000 }))
            expect(again).toMatchObject({ state: 'paused', pending: true, runCount: 1, intervalMs: 120_000 })
            expect(asked).toBe(1)
        })
    })
})
