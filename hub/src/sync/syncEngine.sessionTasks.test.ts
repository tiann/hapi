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
import type { UpdateSessionTaskResult } from './sessionTaskTypes'

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
    return { store, session, sessions, engine, events, internals, sent }
}

type Harness = ReturnType<typeof harness>

function tick(engine: SyncEngine): void {
    // The 5s hub timer entry point.
    ;(engine as unknown as { expireInactive(): void }).expireInactive()
}

const HOUR = 60 * 60_000
/** Let the scheduler's microtasks (and the tick it starts) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The task of an update result. */
function taskOf(result: UpdateSessionTaskResult): SessionTask {
    if (result.type !== 'updated') throw new Error(`unexpected result: ${result.type}`)
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
        const task = result

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
        const task = h.engine.createSessionTask(h.session.id, {
            kind: 'queue',
            items: [{ text: 'first' }, { text: '你好' }],
            intervalMs: 60_000
        })
        expect(task).toMatchObject({ kind: 'queue', totalRuns: 2, maxRuns: null, runCount: 0, startAt: before })
        expect(task.nextRunAt).toBeGreaterThanOrEqual(before)

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
        const task = h.engine.createSessionTask(h.session.id, {
            kind: 'repeat',
            text: 'ping',
            intervalMs: 60_000,
            startAt: before - 30_000
        })
        expect(task.startAt).toBe(before - 30_000)
        expect(task.nextRunAt).toBeGreaterThanOrEqual(before)
    })

    describe('updateSessionTask', () => {
        function createLater(h: Harness, request: CreateSessionTaskRequest): SessionTask {
            return h.engine.createSessionTask(h.session.id, { ...request, startAt: Date.now() + HOUR } as CreateSessionTaskRequest)
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
            const task = h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() - 1_000 })
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
            const task = h.engine.createSessionTask(h.session.id, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000, startAt })
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
    })

    describe('deleteSessionTask', () => {
        async function pendingQueue(h: Harness): Promise<SessionTask> {
            const task = h.engine.createSessionTask(h.session.id, {
                kind: 'queue',
                items: [{ text: 'a' }, { text: 'b' }],
                intervalMs: 60_000
            })
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
        })

        it('answers taken when the agent got the prompt first', async () => {
            const h = harness()
            const task = await pendingQueue(h)
            ;(h.engine as unknown as { cancelQueuedMessage: () => Promise<unknown> }).cancelQueuedMessage = async () => ({ status: 'invoked', message: { invokedAt: 123 } })

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'taken' })
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
        })

        it('answers unconfirmed and still deletes when the cancel cannot be confirmed', async () => {
            const h = harness()
            const task = await pendingQueue(h)
            ;(h.engine as unknown as { cancelQueuedMessage: () => Promise<unknown> }).cancelQueuedMessage = async () => ({ status: 'busy', localId: 'x' })

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'unconfirmed' })
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
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
            const task = h.engine.createSessionTask(h.session.id, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt: Date.now() + HOUR })
            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toEqual({ type: 'deleted', prompt: 'none' })
        })

        it('answers not-found for a task that is not in this session', async () => {
            const h = harness()
            await expect(h.engine.deleteSessionTask(h.session.id, 'missing')).resolves.toEqual({ type: 'not-found' })
        })
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
