import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

/**
 * Runner-verified session liveness fan-out: `machine-alive` heartbeats that
 * carry `aliveSessions` must reach the session cache as declarations, so a
 * session whose own socket is blacked out is neither expired nor left
 * offline. End-to-end through the engine's public surface. The clock is
 * mocked and stepped manually because the engine's expiry tick always reads
 * Date.now().
 */
describe('SyncEngine.handleMachineAlive aliveSessions fan-out', () => {
    const baseTime = 1_780_000_000_000

    function withMutableClock(run: (now: () => number, advance: (ms: number) => void) => void): void {
        const originalDateNow = Date.now
        let current = baseTime
        Date.now = () => current
        try {
            run(() => current, (ms) => { current += ms })
        } finally {
            Date.now = originalDateNow
        }
    }

    function createEngine(store: Store): SyncEngine {
        return new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    }

    function tickExpiry(engine: SyncEngine): void {
        // The expiry tick is private on the engine; drive it directly like the
        // interval would.
        (engine as unknown as { expireInactive: () => void }).expireInactive()
    }

    function createSession(engine: SyncEngine, id: string): string {
        const session = engine.getOrCreateSession(
            id,
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        return session.id
    }

    it('keeps a declared session online past the keepalive timeout and revives it after expiry', () => {
        withMutableClock((now, advance) => {
            const store = new Store(':memory:')
            const engine = createEngine(store)
            const sessionId = createSession(engine, 'session-engine-fanout')
            engine.handleSessionAlive({ sid: sessionId, time: now(), thinking: false })
            engine.handleMachineAlive({ machineId: 'machine-x', time: now(), health: undefined })

            // Heartbeat declaring the session keeps it online past the 30s
            // keepalive timeout.
            advance(10_000)
            engine.handleMachineAlive({ machineId: 'machine-x', time: now(), aliveSessions: [sessionId] })
            advance(25_000)
            tickExpiry(engine)
            expect(engine.getSession(sessionId)?.active).toBe(true)

            // The machine's next heartbeat no longer declares it — expiry
            // resumes within one heartbeat.
            advance(20_000)
            engine.handleMachineAlive({ machineId: 'machine-x', time: now(), aliveSessions: [] })
            advance(1_000)
            tickExpiry(engine)
            expect(engine.getSession(sessionId)?.active).toBe(false)

            // A later declaration revives it.
            advance(20_000)
            engine.handleMachineAlive({ machineId: 'machine-x', time: now(), aliveSessions: [sessionId] })
            expect(engine.getSession(sessionId)?.active).toBe(true)
        })
    })

    it('ignores a non-array aliveSessions value instead of corrupting the declaration set', () => {
        withMutableClock((now, advance) => {
            const store = new Store(':memory:')
            const engine = createEngine(store)
            const sessionId = createSession(engine, 'session-engine-shape')
            engine.handleSessionAlive({ sid: sessionId, time: now(), thinking: false })
            engine.handleMachineAlive({ machineId: 'machine-y', time: now() })

            advance(10_000)
            engine.handleMachineAlive({
                machineId: 'machine-y',
                time: now(),
                aliveSessions: 'not-a-list' as unknown as string[]
            })

            // The bogus declaration must not vouch for the session: it expires
            // on the plain keepalive timeout as if nothing was declared.
            advance(25_000)
            tickExpiry(engine)
            expect(engine.getSession(sessionId)?.active).toBe(false)
        })
    })
})
