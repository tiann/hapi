import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('alive incremental events', () => {
    it('includes active=true in session alive updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-alive-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        events.length = 0
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ active: true }))
    })

    it('emits full active machine object on machine alive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = cache.getOrCreateMachine(
            'machine-alive-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )

        events.length = 0
        cache.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const update = events.find((event) => event.type === 'machine-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'machine-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ id: machine.id, active: true }))
    })

    it('ignores passive Codex transcript socket lifecycle for session active state', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )

        const session = engine.getOrCreateSession(
            'native-hapi-runner',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                startedFromRunner: true,
                startedBy: 'runner'
            },
            null,
            'default'
        )

        try {
            engine.handleSessionAlive({
                sid: session.id,
                time: Date.now(),
                thinking: false,
                source: 'codex-desktop-sync'
            } as Parameters<typeof engine.handleSessionAlive>[0] & { source: 'codex-desktop-sync' })
            expect(engine.getSession(session.id)?.active).toBe(false)

            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            expect(engine.getSession(session.id)).toMatchObject({ active: true, thinking: true })

            engine.handleSessionEnd({
                sid: session.id,
                time: Date.now(),
                source: 'codex-desktop-sync'
            } as Parameters<typeof engine.handleSessionEnd>[0] & { source: 'codex-desktop-sync' })
            expect(engine.getSession(session.id)).toMatchObject({ active: true, thinking: true })
        } finally {
            engine.stop()
        }
    })
})
