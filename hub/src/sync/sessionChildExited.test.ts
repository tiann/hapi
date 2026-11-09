import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { SyncEvent } from '@hapi/protocol/types'
import { SyncEngine } from './syncEngine'

const NAMESPACE = 'default'
const MACHINE = 'machine-1'
const PID = 4242
const START_MARKER = 'Mon Jan  1 00:00:00 2024'

function collectEvents(): { events: SyncEvent[]; sink: { broadcast(event: SyncEvent): void } } {
    const events: SyncEvent[] = []
    return {
        events,
        sink: { broadcast(event: SyncEvent) { events.push(event) } }
    }
}

function createEngine(rooms?: Map<string, Set<string>>): {
    store: Store
    engine: SyncEngine
    events: SyncEvent[]
} {
    const store = new Store(':memory:')
    const { events, sink } = collectEvents()
    const io = rooms
        ? {
            of: (_name: string) => ({
                adapter: { rooms },
                to: () => ({ emit: () => {} })
            })
        }
        : {}
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), sink as never)
    return { store, engine, events }
}

function registerMachine(engine: SyncEngine): void {
    engine.getOrCreateMachine(
        MACHINE,
        { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
        null,
        NAMESPACE
    )
    engine.handleMachineAlive({ machineId: MACHINE, time: Date.now() })
}

function createOwnedSession(
    engine: SyncEngine,
    tag: string,
    overrides: Record<string, unknown> = {}
) {
    return engine.getOrCreateSession(
        tag,
        {
            path: '/tmp/project',
            host: 'localhost',
            machineId: MACHINE,
            hostPid: PID,
            hostStartMarker: START_MARKER,
            startedBy: 'runner',
            lifecycleState: 'running',
            flavor: 'claude',
            claudeSessionId: 'claude-session-1',
            ...overrides
        },
        null,
        NAMESPACE,
        'sonnet'
    )
}

function markActive(engine: SyncEngine, sessionId: string, thinking = true): void {
    engine.handleSessionAlive({
        sid: sessionId,
        time: Date.now(),
        thinking,
        mode: 'remote'
    })
}

describe('handleSessionChildExited owner guard', () => {
    it('marks the current owner inactive instead of waiting for the keep-alive grace', () => {
        const { engine } = createEngine()
        try {
            registerMachine(engine)
            const session = createOwnedSession(engine, 'child-exit-current-owner')
            markActive(engine, session.id)

            expect(engine.getSession(session.id)?.active).toBe(true)
            expect(engine.getSession(session.id)?.thinking).toBe(true)

            const handled = engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: START_MARKER,
                time: Date.now()
            })

            expect(handled).toBe(true)
            const after = engine.getSession(session.id)
            expect(after?.active).toBe(false)
            expect(after?.thinking).toBe(false)
            // "inactive, not archived": the row stays resumable.
            expect(after?.metadata?.lifecycleState).toBe('running')
            expect(after?.metadata?.archivedBy).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('ignores a late notice about an older pid after the session was resumed elsewhere', () => {
        const { engine } = createEngine()
        try {
            registerMachine(engine)
            const session = createOwnedSession(engine, 'child-exit-stale-pid')
            markActive(engine, session.id)

            // Resume elsewhere: same row, new process generation in metadata.
            engine.handleSessionEnd({ sid: session.id, time: Date.now(), reason: 'terminated' })
            const resumedPid = PID + 1
            const current = engine.getSession(session.id)!
            current.metadata = {
                ...current.metadata!,
                hostPid: resumedPid,
                hostStartMarker: 'Tue Jan  2 00:00:00 2024'
            }
            markActive(engine, session.id)

            const handled = engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: START_MARKER,
                time: Date.now()
            })

            expect(handled).toBe(false)
            expect(engine.getSession(session.id)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('ignores a reused pid whose process generation differs', () => {
        const { engine } = createEngine()
        try {
            registerMachine(engine)
            const session = createOwnedSession(engine, 'child-exit-stale-marker')
            markActive(engine, session.id)

            const handled = engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: 'Wed Jan  3 00:00:00 2024',
                time: Date.now()
            })

            expect(handled).toBe(false)
            expect(engine.getSession(session.id)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('ignores a no-marker notice older than the current owner registration when the session has no start marker', () => {
        const { engine } = createEngine()
        try {
            registerMachine(engine)
            // sessionFactory leaves hostStartMarker undefined when the
            // start-marker probe fails, so the guard must fall back to time.
            const firstRegistrationAt = Date.now() - 5_000
            const session = createOwnedSession(engine, 'child-exit-no-marker-stale', {
                hostStartMarker: undefined,
                lifecycleStateSince: firstRegistrationAt
            })
            markActive(engine, session.id)

            // The pid was reused: a new owner generation re-registered the same
            // pid (still without a marker) after the old process had exited.
            const reregisteredAt = Date.now() - 1_000
            const current = engine.getSession(session.id)!
            current.metadata = {
                ...current.metadata!,
                hostPid: PID,
                hostStartMarker: undefined,
                lifecycleStateSince: reregisteredAt
            }

            const staleHandled = engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: undefined,
                time: firstRegistrationAt + 1_000
            })
            expect(staleHandled).toBe(false)
            expect(engine.getSession(session.id)?.active).toBe(true)

            // A notice at or after the current owner's registration is about
            // the live owner and must still deactivate immediately.
            const handled = engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: undefined,
                time: Date.now()
            })
            expect(handled).toBe(true)
            expect(engine.getSession(session.id)?.active).toBe(false)
            expect(engine.getSession(session.id)?.thinking).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('ignores a notice carrying a marker when the session registered none', () => {
        const { engine } = createEngine()
        try {
            registerMachine(engine)
            const session = createOwnedSession(engine, 'child-exit-notice-marker-only', {
                hostStartMarker: undefined
            })
            markActive(engine, session.id)

            const handled = engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: 'Wed Jan  3 00:00:00 2024',
                time: Date.now()
            })

            expect(handled).toBe(false)
            expect(engine.getSession(session.id)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('ignores notices from a different machine or namespace', () => {
        const { engine } = createEngine()
        try {
            registerMachine(engine)
            const session = createOwnedSession(engine, 'child-exit-cross-machine')
            markActive(engine, session.id)

            expect(engine.handleSessionChildExited({
                machineId: 'machine-2',
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: START_MARKER,
                time: Date.now()
            })).toBe(false)
            expect(engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: 'other',
                sid: session.id,
                pid: PID,
                processStartMarker: START_MARKER,
                time: Date.now()
            })).toBe(false)
            expect(engine.getSession(session.id)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('is a no-op for an already inactive session', () => {
        const { engine, events } = createEngine()
        try {
            registerMachine(engine)
            const session = createOwnedSession(engine, 'child-exit-already-inactive')

            expect(engine.getSession(session.id)?.active).toBe(false)
            expect(engine.handleSessionChildExited({
                machineId: MACHINE,
                namespace: NAMESPACE,
                sid: session.id,
                pid: PID,
                processStartMarker: START_MARKER,
                time: Date.now()
            })).toBe(false)
            expect(events.filter((event) => event.type === 'session-ended')).toHaveLength(0)
        } finally {
            engine.stop()
        }
    })
})


describe('resumeSession ghost-active shortcut', () => {
    function withRooms(sessionId: string, live: boolean): Map<string, Set<string>> {
        const rooms = new Map<string, Set<string>>()
        if (live) rooms.set(`session:${sessionId}`, new Set(['socket-1']))
        return rooms
    }

    function prepare(rooms: Map<string, Set<string>>) {
        const { store, engine } = createEngine(rooms)
        registerMachine(engine)
        const session = createOwnedSession(engine, 'ghost-resume', {
            flavor: 'claude',
            claudeSessionId: 'claude-resume-token'
        })
        markActive(engine, session.id)

        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            return { type: 'success', sessionId: session.id }
        }
        ;(engine as any).waitForSessionActive = async () => true
        return { store, engine, session, spawnCalls: () => spawnCalls }
    }

    it('respawns when the hub cache says active but no CLI socket owns the session', async () => {
        const { engine, session, spawnCalls } = prepare(withRooms('', false))
        try {
            const result = await engine.resumeSession(session.id, NAMESPACE)
            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(spawnCalls()).toBe(1)
        } finally {
            engine.stop()
        }
    })

    it('keeps the success shortcut when a live CLI socket owns the session', async () => {
        const { engine, session, spawnCalls } = prepare(new Map())
        try {
            // Build the room map for this concrete session id.
            const rooms = withRooms(session.id, true)
            ;(engine as any).io = {
                of: (_name: string) => ({
                    adapter: { rooms },
                    to: () => ({ emit: () => {} })
                })
            }

            const result = await engine.resumeSession(session.id, NAMESPACE)
            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(spawnCalls()).toBe(0)
        } finally {
            engine.stop()
        }
    })
})
