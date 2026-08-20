import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SessionReaper } from './reaper'
import { SyncEngine } from './syncEngine'

/**
 * Mount-point regression for the hub reaper: `SyncEngine`'s
 * constructor/`stop()` are the only production callers of
 * `SessionReaper.start()`/`stop()`. Sweep-logic correctness itself is
 * covered by reaper.test.ts; this file only pins that the wiring exists and
 * cannot be silently dropped.
 */

const ORIGINAL_ENV = { ...process.env }

function makeEngine(): SyncEngine {
    const store = new Store(':memory:')
    return new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
}

describe('SyncEngine reaper mount point', () => {
    beforeEach(() => {
        delete process.env.HAPI_REAPER_INTERVAL_MS
        delete process.env.HAPI_REAPER_STALE_MS
    })

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV }
    })

    it('sweeps synchronously during construction, but the hub-downtime floor spares a pre-existing zombie until staleMs elapses past hub start', () => {
        // Per reaper.ts's hub-downtime-floor fix, the construction-time
        // sweep can no longer archive anything on its own - every
        // candidate's disconnect-since is floored at the reaper's own
        // `start()` instant (called from `SyncEngine`'s constructor here),
        // which collapses to age zero at that exact moment regardless of how
        // stale its heartbeat looks by wall clock. That is the whole point
        // of the fix: a hub that was down for longer than `staleMs` must not
        // mass-archive every session the instant it comes back up.
        //
        // This still needs to pin that `SyncEngine`'s constructor really
        // does wire up and invoke `SessionReaper.start()` (this file's
        // stated job) independently of that now-quiescent archiving
        // outcome - done by spying on `SessionReaper.prototype.sweep` since
        // the reaper instance itself isn't constructed until `new
        // SyncEngine(...)` runs, so there's nothing to spy on beforehand.
        process.env.HAPI_REAPER_STALE_MS = '60000'
        process.env.HAPI_REAPER_INTERVAL_MS = '3600000'

        const store = new Store(':memory:')
        // `getOrCreateSession` stamps `created_at`/`active_at` from
        // `Date.now()` at insert time and a fresh row is always `active: 0`
        // - so mocking the global clock *during creation* backdates the
        // heartbeat directly, which is the real production mechanism (no
        // row is ever born already-active; `active_at` only advances
        // forward from there via `setSessionActive`'s monotonic guard, so a
        // post-hoc backdate through that method is silently a no-op).
        // Restoring the real clock
        // before constructing `SyncEngine` below is what lets the
        // construction-time sweep see this row as genuinely 2h-disconnected
        // by the real "now" (i.e. by `activeAt` alone - the hub-start floor
        // is what then spares it anyway).
        const originalNow = Date.now
        const backdatedAt = Date.now() - 2 * 60 * 60_000
        Date.now = () => backdatedAt
        let stored: ReturnType<typeof store.sessions.getOrCreateSession>
        try {
            stored = store.sessions.getOrCreateSession(
                'zombie-tag',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
                null,
                'default'
            )
        } finally {
            Date.now = originalNow
        }
        expect(stored.active).toBe(false)

        let sweepCalls = 0
        const originalSweep = SessionReaper.prototype.sweep
        SessionReaper.prototype.sweep = function patchedSweep(this: SessionReaper): string[] {
            sweepCalls += 1
            return originalSweep.call(this)
        }

        let engine: SyncEngine
        try {
            engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never
            )
        } finally {
            SessionReaper.prototype.sweep = originalSweep
        }
        try {
            // Wiring proof: `start()` really did run a sweep during
            // construction, independent of whether it archived anything.
            expect(sweepCalls).toBeGreaterThan(0)

            // Outcome proof: the hub-downtime floor spared it.
            const session = engine.getSession(stored.id)
            expect(session?.metadata?.lifecycleState).toBe('running')
        } finally {
            engine.stop()
        }
    })

    it('mounts a disabled reaper by default: no env override means no sweep timer and no candidate scanning', () => {
        // Per the Major finding from the automated review: shipping the
        // reaper on by default let a CLI riding out a long network
        // partition get archived on heartbeat age alone, with no proof the
        // process was actually dead - the existing reopen flow could then
        // spawn a second agent before the original reconnected. The reaper
        // now defaults to off (`REAPER_DEFAULT_INTERVAL_MS === 0`); this
        // pins that `SyncEngine`'s mount point respects that default instead
        // of forcing an interval of its own.
        //
        // `enabled`/`intervalMs` alone only prove the flags were plumbed
        // through - they don't prove the reaper actually never looks at a
        // candidate. So this also seeds a session that is 45 minutes
        // disconnected with `lifecycleState: 'running'` (past the 30min
        // default staleness threshold, so it would be reaped in a heartbeat
        // if a sweep ever ran against it), spies on
        // `SessionReaper.prototype.sweep` to assert it is never called, and
        // asserts the session is still `running` after construction - proof
        // the disabled reaper does not scan candidates, not just that its
        // config says it shouldn't.
        const store = new Store(':memory:')
        const originalNow = Date.now
        const backdatedAt = Date.now() - 45 * 60_000
        Date.now = () => backdatedAt
        let stored: ReturnType<typeof store.sessions.getOrCreateSession>
        try {
            stored = store.sessions.getOrCreateSession(
                'stale-but-untouched',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
                null,
                'default'
            )
        } finally {
            Date.now = originalNow
        }
        expect(stored.active).toBe(false)

        let sweepCalls = 0
        const originalSweep = SessionReaper.prototype.sweep
        SessionReaper.prototype.sweep = function patchedSweep(this: SessionReaper): string[] {
            sweepCalls += 1
            return originalSweep.call(this)
        }

        let engine: SyncEngine
        try {
            engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never
            )
        } finally {
            SessionReaper.prototype.sweep = originalSweep
        }
        const reaper = (engine as unknown as { reaper: SessionReaper }).reaper
        try {
            expect(reaper.enabled).toBe(false)
            expect(reaper.intervalMs).toBe(0)
            expect(sweepCalls).toBe(0)

            const session = engine.getSession(stored.id)
            expect(session?.metadata?.lifecycleState).toBe('running')
        } finally {
            engine.stop()
        }
    })

    it('stop() delegates to the reaper, clearing its periodic timer', () => {
        const engine = makeEngine()
        const reaper = (engine as unknown as { reaper: SessionReaper }).reaper
        expect(reaper).toBeInstanceOf(Object)

        let stopCalls = 0
        const originalStop = reaper.stop.bind(reaper)
        reaper.stop = () => {
            stopCalls += 1
            originalStop()
        }

        engine.stop()

        expect(stopCalls).toBe(1)
    })
})
