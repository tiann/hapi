import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine(store?: Store): SyncEngine {
    const engine = new SyncEngine(
        store ?? new Store(':memory:'),
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    engine.stop()
    return engine
}

function simulateHubRestart(store: Store): SyncEngine {
    return createEngine(store)
}

describe('session active-flag persistence on reactivation', () => {
    it('persists active=true from handleSessionAlive so it survives a hub restart', () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = engine.getOrCreateSession(
            'reactivate-via-alive',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        // Fresh session rows start inactive - confirm the precondition before
        // asserting the reactivation write below.
        expect(store.sessions.getSession(session.id)?.active).toBe(false)

        engine.handleSessionAlive({ sid: session.id, time: Date.now() })

        // Read straight from the store, bypassing the in-memory cache, so a
        // fix that only flips the cached Session (and never calls
        // store.sessions.setSessionActive) fails this assertion.
        expect(store.sessions.getSession(session.id)?.active).toBe(true)

        const reloadedEngine = simulateHubRestart(store)
        expect(reloadedEngine.getSession(session.id)?.active).toBe(true)
    })

    it('persists active=true from markSessionActive so it survives a hub restart', () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = engine.getOrCreateSession(
            'reactivate-via-markactive',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        expect(store.sessions.getSession(session.id)?.active).toBe(false)

        ;(engine as unknown as { sessionCache: { markSessionActive: (id: string, time?: number) => void } })
            .sessionCache.markSessionActive(session.id, Date.now())

        expect(store.sessions.getSession(session.id)?.active).toBe(true)

        const reloadedEngine = simulateHubRestart(store)
        expect(reloadedEngine.getSession(session.id)?.active).toBe(true)
    })

    it('writes the active=true persistence exactly once on activation, and does not re-issue it on a repeat heartbeat', () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = engine.getOrCreateSession(
            'repeat-heartbeat-no-rewrite',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )

        let calls = 0
        const originalSetSessionActive = store.sessions.setSessionActive.bind(store.sessions)
        store.sessions.setSessionActive = ((...args: Parameters<typeof originalSetSessionActive>) => {
            calls += 1
            return originalSetSessionActive(...args)
        }) as typeof store.sessions.setSessionActive

        engine.handleSessionAlive({ sid: session.id, time: Date.now() })

        // Reverse-guard half of the contract: the false->true edge really
        // does persist once. Without asserting this first, an implementation
        // that never persists reactivation at all would also satisfy the
        // "no rewrite on repeat" assertion below vacuously, with calls
        // staying at 0 throughout instead of settling at 1.
        expect(calls).toBe(1)
        const afterFirst = store.sessions.getSession(session.id)
        expect(afterFirst?.active).toBe(true)

        engine.handleSessionAlive({ sid: session.id, time: Date.now() + 1000 })

        expect(calls).toBe(1)
    })

    it('reconciles a store row left active=true past the inactivity threshold (e.g. after a hub crash) back to false on the next periodic sweep', () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        // Persist active=true with an activeAt already past the 30s
        // inactivity threshold, as if the hub process died right after the
        // last heartbeat landed and came back up later: the reactivation-
        // persistence fix means active=true can now sit in the store across
        // a restart (previously it was purely in-memory and always reloaded
        // as false), so this "stuck active, stale heartbeat" row shape is
        // newly reachable and must not be trusted as a live session forever.
        // Both the session's creation and the heartbeat that activates it
        // are backdated together: `setSessionActive`'s activeAt write has a
        // monotonic guard (never regresses to an earlier value than the row
        // already has), so activating with a stale time against a row
        // created at the real "now" would silently keep the row's fresher
        // creation-time activeAt instead of the stale one this fixture needs.
        const originalNow = Date.now
        const staleActiveAt = originalNow() - 31_000
        Date.now = () => staleActiveAt
        let session: ReturnType<typeof engine.getOrCreateSession>
        try {
            session = engine.getOrCreateSession(
                'stale-active-survives-restart',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                null,
                'default'
            )
            engine.handleSessionAlive({ sid: session.id, time: staleActiveAt })
        } finally {
            Date.now = originalNow
        }
        expect(store.sessions.getSession(session.id)?.active).toBe(true)

        const reloadedEngine = simulateHubRestart(store)
        expect(reloadedEngine.getSession(session.id)?.active).toBe(true)

        // Fire one tick of the periodic 5s expireInactive sweep that
        // SyncEngine's constructor arms via setInterval - this is the
        // convergence mechanism this test exists to pin, invoked directly
        // (bypassing TypeScript's compile-time-only `private`) instead of
        // waiting on a real timer.
        ;(reloadedEngine as unknown as { expireInactive: () => void }).expireInactive()

        expect(reloadedEngine.getSession(session.id)?.active).toBe(false)
        // Read straight from the store, bypassing the cache, so a fix that
        // only flips the cached Session (and never calls
        // store.sessions.setSessionActive) fails this assertion - same
        // bypass rationale as the reactivation tests above, mirrored for
        // the expiry direction.
        expect(store.sessions.getSession(session.id)?.active).toBe(false)
    })
})
