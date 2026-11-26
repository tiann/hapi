import { afterEach, describe, expect, it, mock } from 'bun:test'
import { SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX, type CreateSessionTaskRequest, type SessionTask } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

type FakeSession = { id: string; namespace: string; active: boolean }

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
    return { engine, events, internals }
}

function makeSession(store: Store, tag: string): FakeSession {
    const id = store.sessions.getOrCreateSession(tag, { path: '/tmp', flavor: 'cursor' }, null, 'default').id
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

describe('SyncEngine session tasks', () => {
    afterEach(() => {
        mock.restore()
    })

    it('creates a repeat task with its first run at startAt and announces the change', () => {
        const h = harness()
        const startAt = Date.now() + HOUR
        const task = h.engine.createSessionTask(h.session.id, {
            kind: 'repeat',
            text: '  report  ',
            intervalMs: 60_000,
            maxRuns: 3,
            startAt
        })

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
        expect(task).toMatchObject({ kind: 'queue', totalRuns: 2, maxRuns: null, runCount: 0 })
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

            const paused = h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            expect(paused).toMatchObject({ state: 'paused', nextRunAt: null, lastError: null })
            expect(h.events.at(-1)).toEqual({ type: 'session-tasks-changed', sessionId: h.session.id })
        })

        it('resume runs a task with nothing pending now', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            h.engine.updateSessionTask(h.session.id, task.id, { paused: true })
            const before = Date.now()

            const resumed = h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            expect(resumed?.state).toBe('active')
            expect(resumed?.nextRunAt).toBeGreaterThanOrEqual(before)
            await settle()
            expect(h.sent).toHaveLength(1)
        })

        it('resume keeps a queue task spaced from when its last prompt was taken', () => {
            const h = harness()
            const now = Date.now()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 30 * 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:x:1', nextRunAt: null, now })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: now - 5 * 60_000, nextRunAt: now + 25 * 60_000, now })
            h.store.sessionTasks.setPaused(task.id, true, null, now)

            // Paused for a moment: the rest of the spacing is kept.
            expect(h.engine.updateSessionTask(h.session.id, task.id, { paused: false })?.nextRunAt).toBe(now + 25 * 60_000)
        })

        it('resume runs a queue task whose spacing elapsed while it was paused', () => {
            const h = harness()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 30 * 60_000 })
            const takenAt = Date.now() - 3 * HOUR
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:x:1', nextRunAt: null, now: takenAt })
            h.store.sessionTasks.settlePending(task.id, { consumedAt: takenAt, nextRunAt: takenAt + 30 * 60_000, now: takenAt })
            h.store.sessionTasks.setPaused(task.id, true, null, takenAt + 1000)
            const before = Date.now()

            expect(h.engine.updateSessionTask(h.session.id, task.id, { paused: false })?.nextRunAt).toBeGreaterThanOrEqual(before)
        })

        it('resume leaves a queue task unscheduled while its prompt is still pending', () => {
            const h = harness()
            const task = createLater(h, { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], intervalMs: 60_000 })
            h.store.sessionTasks.markSent(task.id, { localId: 'hapi-task:y:1', nextRunAt: null, now: Date.now() })
            h.store.sessionTasks.setPaused(task.id, true, null, Date.now())

            const resumed = h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            expect(resumed).toMatchObject({ state: 'active', nextRunAt: null, pending: true })
        })

        it('leaves the schedule of a task that is already running alone', async () => {
            const h = harness()
            const task = createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })

            const untouched = h.engine.updateSessionTask(h.session.id, task.id, { paused: false })
            expect(untouched?.nextRunAt).toBe(task.nextRunAt)
            await settle()
            expect(h.sent).toEqual([])
        })

        it('returns null for a task that is not in this session', () => {
            const h = harness()
            createLater(h, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
            expect(h.engine.updateSessionTask(h.session.id, 'missing', { paused: true })).toBeNull()
        })
    })

    describe('deleteSessionTask', () => {
        it('cancels a prompt the agent has not taken yet', async () => {
            const h = harness()
            const task = h.engine.createSessionTask(h.session.id, {
                kind: 'queue',
                items: [{ text: 'a' }, { text: 'b' }],
                intervalMs: 60_000
            })
            await settle()
            const cancelled: Array<{ sessionId: string; localId: string }> = []
            ;(h.engine as unknown as { cancelQueuedMessage: (id: string, localId: string) => Promise<unknown> }).cancelQueuedMessage = async (id, localId) => {
                cancelled.push({ sessionId: id, localId })
                return { status: 'cancelled', localId }
            }

            await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toBe(true)
            expect(cancelled).toEqual([{ sessionId: h.session.id, localId: `${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}${task.id}:1` }])
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
        })

        it('removes the task even when cancelling the pending prompt fails', async () => {
            const h = harness()
            const task = h.engine.createSessionTask(h.session.id, {
                kind: 'queue',
                items: [{ text: 'a' }, { text: 'b' }],
                intervalMs: 60_000
            })
            await settle()
            const warn = mock(() => undefined)
            const originalWarn = console.warn
            console.warn = warn
            try {
                ;(h.engine as unknown as { cancelQueuedMessage: () => Promise<unknown> }).cancelQueuedMessage = async () => {
                    throw new Error('CLI offline')
                }
                await expect(h.engine.deleteSessionTask(h.session.id, task.id)).resolves.toBe(true)
            } finally {
                console.warn = originalWarn
            }
            expect(h.engine.listSessionTasks(h.session.id)).toEqual([])
        })

        it('answers false for a task that is not in this session', async () => {
            const h = harness()
            await expect(h.engine.deleteSessionTask(h.session.id, 'missing')).resolves.toBe(false)
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
            nextRunAt: Date.now() - 1
        })

        tick(h.engine)
        await settle()
        expect(h.sent).toHaveLength(1)
    })
})
