import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

type FakeSession = { id: string; namespace: string; active: boolean }

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

    function harness() {
        const store = new Store(':memory:')
        const idle = makeSession(store, 'idle')
        idle.active = false
        const running = makeSession(store, 'running')
        const sessions = new Map<string, FakeSession>([[idle.id, idle], [running.id, running]])
        const { engine, internals } = stubEngine(store, sessions)
        const resumed: string[] = []
        internals.resumeSession = async (id: string) => {
            resumed.push(id)
            return { type: 'error', code: 'no_machine_online', message: 'No machine online' }
        }
        // What MessageService.releaseMatureScheduledMessages reports for this tick.
        const released = { sessions: [] as string[] }
        internals.messageService = {
            releaseMatureScheduledMessages: () => released.sessions
        }
        return { engine, resumed, released, idle, running }
    }

    it('resumes the session that is not running and leaves a running one alone', async () => {
        const h = harness()
        h.released.sessions = [h.running.id, h.idle.id]

        tick(h.engine)
        await settle()

        expect(h.resumed).toEqual([h.idle.id])
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
})
