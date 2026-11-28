import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { EventPublisher } from './eventPublisher'
import { SessionWakeGate, type SessionWakeResumeResult } from './sessionWakeGate'
import { SyncEngine } from './syncEngine'

type FakeSession = { id: string; namespace: string; active: boolean; metadata?: { lifecycleState?: string; name?: string; path?: string } }

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

/**
 * Minimal construction, the same pattern as sessionJobWake.engine.test.ts:
 * Object.create skips field initializers, so only the collaborators the tick
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
    internals.reportedScheduledMessages = new Set<string>()
    internals.openCodeRewindPending = () => false
    internals.reconcileOpenCodeClears = async () => undefined
    internals.reconcileDerivedToolWork = () => undefined
    return { engine, events, internals }
}

function makeSession(store: Store, tag: string): FakeSession {
    const id = store.sessions.getOrCreateSession(tag, { path: '/tmp', flavor: 'cursor' }, null, 'default').id
    return { id, namespace: 'default', active: true, metadata: { path: '/tmp' } }
}

/** The 5s hub timer entry point. */
function tick(engine: SyncEngine): void {
    ;(engine as unknown as { expireInactive(): void }).expireInactive()
}

/** Let a wake attempt (and its rejection) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('SyncEngine resumes a session whose scheduled message came due', () => {
    afterEach(() => {
        mock.restore()
    })

    function harness(options: { backoffMs?: number } = {}) {
        const store = new Store(':memory:')
        const idle = makeSession(store, 'idle')
        idle.active = false
        const running = makeSession(store, 'running')
        const sessions = new Map<string, FakeSession>([[idle.id, idle], [running.id, running]])
        const { engine, events, internals } = stubEngine(store, sessions)
        const resumed: string[] = []
        /** What a resume answers. */
        const resume: { result: SessionWakeResumeResult } = {
            result: { type: 'error', code: 'no_machine_online', message: 'No machine online' }
        }
        const wakeable = (id: string) => {
            const session = sessions.get(id)
            return session
                ? { id: session.id, namespace: session.namespace, active: session.active, archived: session.metadata?.lifecycleState === 'archived' }
                : null
        }
        // The gate the engine would build, minus the backoff where a test wants every tick to be an attempt.
        internals.wakeGate = new SessionWakeGate({
            getSession: wakeable,
            resumeSession: async (id) => {
                resumed.push(id)
                return resume.result
            },
            baseBackoffMs: options.backoffMs
        })
        // What MessageService.releaseMatureScheduledMessages reports for this tick.
        const released = { sessions: [] as string[] }
        internals.messageService = {
            releaseMatureScheduledMessages: () => released.sessions
        }
        const toasts: Array<{ namespace: string; event: ToastEvent }> = []
        /** How many visible connections the SSE manager reports for the next toast. */
        const delivery = { count: 1 }
        internals.eventPublisher = {
            emit: (event: SyncEvent) => { events.push(event) },
            sendToast: async (namespace: string, event: ToastEvent) => {
                toasts.push({ namespace, event })
                return delivery.count
            }
        }
        /** A scheduled message that came due a second ago, waiting for the session to take it. */
        const schedule = (sessionId: string, localId: string, text: string) =>
            store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text } }, localId, Date.now() - 1_000)
        return { engine, internals, resumed, resume, released, idle, running, sessions, toasts, delivery, schedule }
    }

    it('resumes the session that is not running and leaves a running one alone', async () => {
        const h = harness()
        h.released.sessions = [h.running.id, h.idle.id]

        tick(h.engine)
        await settle()

        expect(h.resumed).toEqual([h.idle.id])
        expect(h.toasts).toEqual([])
    })

    it('resumes nothing when no scheduled message was released', async () => {
        const h = harness()

        tick(h.engine)
        await settle()

        expect(h.resumed).toEqual([])
    })

    it('backs off after a failed resume instead of retrying on every tick', async () => {
        const h = harness()
        h.released.sessions = [h.idle.id]

        tick(h.engine)
        await settle()
        expect(h.resumed).toEqual([h.idle.id])

        tick(h.engine)
        tick(h.engine)
        await settle()
        expect(h.resumed).toEqual([h.idle.id])
    })

    describe('a session that cannot be resumed', () => {
        const refused = (code: string, message: string): SessionWakeResumeResult => ({ type: 'error', code, message })

        it('tells the user through a toast, once per scheduled message and hub process', async () => {
            const h = harness({ backoffMs: 0 })
            h.resume.result = refused('resume_unavailable', 'Retry after the agent has initialized')
            h.released.sessions = [h.idle.id]
            h.schedule(h.idle.id, 'local-1', 'report the build')
            h.idle.metadata = { name: 'hapi' }

            tick(h.engine)
            await settle()
            expect(h.toasts).toEqual([{
                namespace: 'default',
                event: {
                    type: 'toast',
                    data: {
                        title: 'Scheduled message not sent',
                        body: '"report the build" is waiting in hapi: the session could not be resumed. The hub keeps retrying.',
                        sessionId: h.idle.id,
                        url: `/sessions/${h.idle.id}`
                    }
                }
            }])

            // Every tick is a new refused attempt (no backoff here); the message is not reported twice.
            tick(h.engine)
            await settle()
            tick(h.engine)
            await settle()
            expect(h.resumed).toHaveLength(3)
            expect(h.toasts).toHaveLength(1)

            // A message that comes due later is reported in its turn.
            h.schedule(h.idle.id, 'local-2', 'ship it')
            tick(h.engine)
            await settle()
            expect(h.toasts.map(({ event }) => event.data.body)).toEqual([
                '"report the build" is waiting in hapi: the session could not be resumed. The hub keeps retrying.',
                '"ship it" is waiting in hapi: the session could not be resumed. The hub keeps retrying.'
            ])
        })

        it('names the session by its folder when it has no name, and a slash command only as a message', async () => {
            const h = harness({ backoffMs: 0 })
            h.resume.result = refused('resume_failed', 'Session did not become active')
            h.released.sessions = [h.idle.id]
            h.schedule(h.idle.id, 'local-slash', '/compact')

            tick(h.engine)
            await settle()
            expect(h.toasts).toHaveLength(1)
            expect(h.toasts[0]?.event.data.body).toBe(
                'A scheduled message is waiting in tmp: the session could not be resumed. The hub keeps retrying.'
            )
        })

        it('offers the toast again while no visible connection has received it', async () => {
            const h = harness({ backoffMs: 0 })
            h.resume.result = refused('resume_unavailable', 'Retry after the agent has initialized')
            h.released.sessions = [h.idle.id]
            h.schedule(h.idle.id, 'local-1', 'report the build')

            h.delivery.count = 0
            tick(h.engine)
            await settle()
            expect(h.toasts).toHaveLength(1)
            // Nobody was looking: the next refused attempt offers it again.
            h.delivery.count = 1
            tick(h.engine)
            await settle()
            expect(h.toasts).toHaveLength(2)
            // Received once: that is the once.
            tick(h.engine)
            await settle()
            expect(h.toasts).toHaveLength(2)
        })

        it('reports the other resume refusals the same way', async () => {
            const h = harness({ backoffMs: 0 })
            h.released.sessions = [h.idle.id]
            h.schedule(h.idle.id, 'local-1', 'ping')
            for (const code of ['session_not_found', 'access_denied']) {
                h.resume.result = refused(code, code)
                tick(h.engine)
                await settle()
            }
            // Two refused attempts, one message: one toast.
            expect(h.resumed).toHaveLength(2)
            expect(h.toasts).toHaveLength(1)
        })

        it('says nothing while the machine is offline: that clears by itself', async () => {
            const h = harness({ backoffMs: 0 })
            h.resume.result = refused('no_machine_online', 'No machine online')
            h.released.sessions = [h.idle.id]
            h.schedule(h.idle.id, 'local-1', 'ping')

            tick(h.engine)
            await settle()
            tick(h.engine)
            await settle()
            expect(h.resumed).toHaveLength(2)
            expect(h.toasts).toEqual([])
        })

        it('says nothing for an archived session, which is not resumed at all', async () => {
            const h = harness()
            h.resume.result = refused('resume_unavailable', 'Retry after the agent has initialized')
            h.idle.metadata = { lifecycleState: 'archived' }
            h.released.sessions = [h.idle.id]
            h.schedule(h.idle.id, 'local-1', 'ping')

            tick(h.engine)
            await settle()
            expect(h.resumed).toEqual([])
            expect(h.toasts).toEqual([])
        })

        it('only reports the messages of the session that was refused', async () => {
            const h = harness({ backoffMs: 0 })
            h.resume.result = refused('resume_unavailable', 'Retry after the agent has initialized')
            h.schedule(h.idle.id, 'local-1', 'mine')
            h.schedule(h.running.id, 'local-other', 'not mine')
            h.released.sessions = [h.idle.id, h.running.id]

            tick(h.engine)
            await settle()
            expect(h.toasts.map(({ event }) => event.data.sessionId)).toEqual([h.idle.id])
        })

        it('reaches a visible connection of the namespace as a toast frame', async () => {
            const h = harness({ backoffMs: 0 })
            h.resume.result = refused('resume_unavailable', 'Retry after the agent has initialized')
            h.released.sessions = [h.idle.id]
            h.schedule(h.idle.id, 'local-1', 'report the build')
            // The real publisher over the real SSE manager, one visible web connection.
            const manager = new SSEManager(0, new VisibilityTracker())
            const frames: Array<{ event: SyncEvent; eventId: string | undefined }> = []
            manager.subscribe({
                id: 'web',
                namespace: 'default',
                all: true,
                visibility: 'visible',
                send: (event, eventId) => { frames.push({ event, eventId }) },
                sendHeartbeat: () => {}
            })
            h.internals.eventPublisher = new EventPublisher(manager, () => undefined)

            tick(h.engine)
            await settle()
            expect(frames).toEqual([{
                eventId: undefined,
                event: {
                    type: 'toast',
                    data: {
                        title: 'Scheduled message not sent',
                        body: '"report the build" is waiting in tmp: the session could not be resumed. The hub keeps retrying.',
                        sessionId: h.idle.id,
                        url: `/sessions/${h.idle.id}`
                    }
                }
            }])
        })
    })
})
