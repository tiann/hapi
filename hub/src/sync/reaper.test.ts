import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import {
    REAPER_DEFAULT_INTERVAL_MS,
    REAPER_DEFAULT_STALE_MS,
    SessionReaper
} from './reaper'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

/**
 * Drives a session through the hub's real disconnect path instead of
 * hand-mutating the cached Session object: a heartbeat at `heartbeatAt`
 * (the same `handleSessionAlive` entrypoint every CLI keepAlive uses) then
 * a 30s-inactivity sweep (`SessionCache.expireInactive`, the same one
 * `SyncEngine`'s 5s timer drives) checked at `expireCheckAt`, which is the
 * only production path that flips `active` back to `false`.
 *
 * Throws if the session did not actually go inactive, so a bad
 * `expireCheckAt` (too close to `heartbeatAt`) fails loudly at the call
 * site instead of silently producing a still-active fixture.
 */
function connectThenDisconnect(
    cache: SessionCache,
    sessionId: string,
    heartbeatAt: number,
    expireCheckAt: number
): void {
    cache.handleSessionAlive({ sid: sessionId, time: heartbeatAt })
    const expired = cache.expireInactive(expireCheckAt)
    if (!expired.includes(sessionId)) {
        throw new Error(
            `test setup: session ${sessionId} did not go inactive via expireInactive(${expireCheckAt}) ` +
            `after heartbeat at ${heartbeatAt} - widen the gap past the 30s inactivity timeout`
        )
    }
}

const ORIGINAL_ENV = { ...process.env }

describe('SessionReaper (hub reaper)', () => {
    beforeEach(() => {
        delete process.env.HAPI_REAPER_INTERVAL_MS
        delete process.env.HAPI_REAPER_STALE_MS
    })

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV }
    })

    it('ships disabled by default: interval 0, and a 30min staleness ready for whenever an operator opts in', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const reaper = new SessionReaper(cache)

        expect(reaper.intervalMs).toBe(REAPER_DEFAULT_INTERVAL_MS)
        expect(reaper.staleMs).toBe(REAPER_DEFAULT_STALE_MS)
        expect(REAPER_DEFAULT_INTERVAL_MS).toBe(0)
        expect(REAPER_DEFAULT_STALE_MS).toBe(30 * 60_000)
        expect(reaper.enabled).toBe(false)
    })

    it('does not start a sweep timer, and sweep() is a no-op, when constructed with no options at all (default-off)', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-default-off',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 45 * 60_000)

        const reaper = new SessionReaper(cache, { now: () => now + 45 * 60_000 })
        expect(reaper.enabled).toBe(false)

        reaper.start()
        try {
            expect(reaper.sweep()).toEqual([])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
        } finally {
            reaper.stop()
        }
    })

    it('honors HAPI_REAPER_INTERVAL_MS / HAPI_REAPER_STALE_MS overrides', () => {
        process.env.HAPI_REAPER_INTERVAL_MS = '1000'
        process.env.HAPI_REAPER_STALE_MS = '2000'
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const reaper = new SessionReaper(cache)

        expect(reaper.intervalMs).toBe(1000)
        expect(reaper.staleMs).toBe(2000)
    })

    it('archives a disconnected running session past the stale threshold, with reaper attribution', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-stale',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        // Heartbeat lands, then the connection drops for good - the last
        // heartbeat itself is what needs to be 31 minutes stale, not just
        // the disconnect-detection tick.
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 31 * 60_000 })
        const reaped = reaper.sweep()

        expect(reaped).toEqual([session.id])
        const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(meta?.lifecycleState).toBe('archived')
        expect(meta?.archivedBy).toBe('hub-reaper')
        expect(meta?.archiveReason).toBe('Connection lost (reaped by hub)')
        expect(typeof meta?.lifecycleStateSince).toBe('number')
    })

    it('broadcasts exactly one full session-updated event for each session it reaps, via refreshSession - no duplicate metadata-patch emit', () => {
        // A reaped session's `active` is already `false` by construction
        // (that is the reaper's own candidate precondition), so the usual
        // `handleSessionEnd`-driven broadcast (which no-ops when the session
        // is already inactive) never fires for it. `markSessionArchivedFromHub`
        // relies entirely on `refreshSession`'s own broadcast for this - it
        // does not additionally hand-roll a metadata-patch emit, so exactly
        // one `session-updated` event per reap is expected, carrying the full
        // rebuilt `Session` (not a `{ metadata: { version, value } }` patch).
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-broadcast',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)
        events.length = 0 // drop the connect/disconnect noise; only the sweep's own broadcast matters here

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 31 * 60_000 })
        expect(reaper.sweep()).toEqual([session.id])

        const updates = events.filter(
            (event): event is Extract<SyncEvent, { type: 'session-updated' }> =>
                event.type === 'session-updated' && event.sessionId === session.id
        )
        expect(updates).toHaveLength(1)
        const data = updates[0]?.data as { metadata?: Record<string, unknown> | null } | undefined
        expect(data?.metadata?.lifecycleState).toBe('archived')
        expect(data?.metadata?.archivedBy).toBe('hub-reaper')
    })

    it('leaves a disconnected running session alone when under the stale threshold', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-fresh',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 5 * 60_000 })
        const reaped = reaper.sweep()

        expect(reaped).toEqual([])
        const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(meta?.lifecycleState).toBe('running')
    })

    it('does not reap a long-idle-but-recently-heartbeating session just because updatedAt is stale', () => {
        // A session can sit quiet (no chat activity, `updatedAt` old) for a
        // long time while the CLI keeps sending keepAlives right up until a
        // brief network blip / lid-close drops the socket 31s before this
        // sweep. A stale `updatedAt` alone must never doom a session whose
        // heartbeat was fresh. (This guards against updatedAt-driven
        // reaping; the fixture that pins the activeAt-vs-Math.max choice is
        // "reaps a dead session even while hub-side writes keep updatedAt
        // fresh" below.)
        //
        // Rewritten per review: the original fixture fed `handleSessionAlive`
        // a `time` in the future relative to the *real* `Date.now()` -
        // `aliveTime.ts`'s `clampAliveTime` only accepts `[now-10min, now]`
        // and silently clamps anything past `now` down to it, so the
        // intended "40 quiet minutes, then a fresh heartbeat" scenario never
        // actually landed in `activeAt`. Mocking the global `Date.now()`
        // (same pattern as `aliveEvents.test.ts`) instead of the argument lets
        // the heartbeat's `time` legitimately equal "now" at each step while
        // `updatedAt` (stamped once, at creation, against the *unmocked* real
        // clock just before) stays behind.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const t0 = Date.now()
        const originalNow = Date.now

        const session = cache.getOrCreateSession(
            'session-idle-but-alive',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        const heartbeatAt = t0 + 40 * 60_000 // 40 quiet minutes pass, then a heartbeat lands
        try {
            Date.now = () => heartbeatAt
            connectThenDisconnect(cache, session.id, heartbeatAt, heartbeatAt + 31_000) // ...and drops 31s later
        } finally {
            Date.now = originalNow
        }

        // `updatedAt` (session creation, ~`t0`) is ~40min+31s stale here,
        // well past the 30min threshold - but the real heartbeat is only
        // 31s old.
        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => heartbeatAt + 31_000 + 1_000 })
        const reaped = reaper.sweep()

        expect(reaped).toEqual([])
        expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
    })

    it('reaps a session whose heartbeat itself is stale, even though updatedAt is comparatively newer', () => {
        // `updatedAt` newer than `activeAt` must not mask a genuinely stale
        // heartbeat. Note both clocks are past the threshold here, so this
        // case alone does not pin the field choice - that is the job of
        // "reaps a dead session even while hub-side writes keep updatedAt
        // fresh" below, where `updatedAt` is still under the threshold.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-stale-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        // Heartbeat drops almost immediately and never comes back.
        connectThenDisconnect(cache, session.id, now, now + 31_000)
        // Some later hub-side write bumps updatedAt past the heartbeat time
        // (e.g. a delayed housekeeping touch) - still 35 minutes before the
        // sweep, i.e. itself past the stale threshold.
        cache.recordSessionActivity(session.id, now + 5 * 60_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 40 * 60_000 })
        const reaped = reaper.sweep()

        expect(reaped).toEqual([session.id])
        expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')
    })

    it('reaps a dead session even while hub-side writes keep updatedAt fresh (activeAt is the only staleness clock)', () => {
        // THE discriminating fixture for the staleness-field choice, kept
        // deliberately asymmetric: the heartbeat has been gone 40 minutes
        // (well past the 30min threshold) while a hub-side write - a web
        // client posting into the void 25 minutes in - leaves `updatedAt`
        // only 15 minutes old at sweep time, i.e. UNDER the threshold.
        // activeAt-only reaps this session; any variant that lets
        // `updatedAt` extend the clock (e.g. Math.max(activeAt, updatedAt))
        // skips it and lets every chattered-at zombie live forever.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-dead-but-touched',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        // Heartbeat drops at the start and never returns.
        connectThenDisconnect(cache, session.id, now, now + 31_000)
        // 25 minutes in, something hub-side touches the row (web message
        // into the dead session) - fresher than staleMs at sweep time.
        cache.recordSessionActivity(session.id, now + 25 * 60_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 40 * 60_000 })
        const reaped = reaper.sweep()

        expect(reaped).toEqual([session.id])
        expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')
    })

    it('leaves an active (connected) session alone regardless of how stale its heartbeat looks by wall-clock', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-active',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        cache.handleSessionAlive({ sid: session.id, time: now })
        expect(cache.getSession(session.id)?.active).toBe(true)

        // staleMs: 1 - if the `active` short-circuit were ever dropped, any
        // nonzero elapsed time would make this reap.
        const reaper = new SessionReaper(cache, { staleMs: 1, intervalMs: 5 * 60_000, now: () => now + 60 * 60_000 })
        const reaped = reaper.sweep()

        expect(reaped).toEqual([])
    })

    it('does not re-reap a session already lifecycleState=archived', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-already-archived',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 60 * 60_000 })
        const reaped = reaper.sweep()

        expect(reaped).toEqual([])
        const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(meta?.archivedBy).toBe('cli')
    })

    it('reconnect after being reaped self-heals lifecycleState back to running, and a later sweep leaves it alone', () => {
        // Regression: a session the reaper archived must
        // stop *looking* archived the moment its CLI genuinely reconnects -
        // the web UI must not keep showing "archived" for a live session
        // until some unrelated manual /reopen. `SessionCache`'s reconnect-heal
        // (invoked from `handleSessionAlive`, the entrypoint every CLI
        // keepAlive - and so every reconnect - uses) is what restamps
        // `lifecycleState` back to `'running'` and clears the reaper's
        // archive attribution, with no CLI-side step required.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-revives',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 31 * 60_000 })
        expect(reaper.sweep()).toEqual([session.id])
        const archivedMeta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(archivedMeta?.lifecycleState).toBe('archived')
        const versionAfterReap = cache.getSession(session.id)?.metadataVersion
        events.length = 0 // drop the reap's own broadcast; only the heal's broadcast matters below

        // CLI reconnects for real: a keepAlive flips `active` back to `true`
        // via the exact entrypoint every reconnect uses, and - per the fix -
        // heals the archive metadata in the same call.
        const reconnectAt = now + 31 * 60_000 + 5_000
        cache.handleSessionAlive({ sid: session.id, time: reconnectAt })
        expect(cache.getSession(session.id)?.active).toBe(true)

        const healedMeta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(healedMeta?.lifecycleState).toBe('running')
        expect(healedMeta?.archivedBy).toBeUndefined()
        expect(healedMeta?.archiveReason).toBeUndefined()
        expect(cache.getSession(session.id)?.metadataVersion).toBeGreaterThan(versionAfterReap ?? 0)

        const updates = events.filter(
            (event): event is Extract<SyncEvent, { type: 'session-updated' }> =>
                event.type === 'session-updated' && event.sessionId === session.id
        )
        const healBroadcast = updates
            .map((event) => {
                const data = event.data as { metadata?: { value: Record<string, unknown> | null } } | undefined
                return data?.metadata?.value
            })
            .find((value) => value?.lifecycleState === 'running')
        expect(healBroadcast).toBeDefined()

        const laterReaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => reconnectAt + 60 * 60_000 })
        expect(laterReaper.sweep()).toEqual([])
        expect(cache.getSession(session.id)?.active).toBe(true)
    })

    it('reconnect via markSessionActive (the resume-on-respawn path) also self-heals lifecycleState back to running', () => {
        // Mutation-coverage gap: the heal is
        // wired into *two* entrypoints - `handleSessionAlive` (every CLI
        // keepAlive, exercised by the test above) and `markSessionActive`
        // (the session-respawn/resume path). Only the former had coverage;
        // a mutation that deleted the `healReaperArchivedSession` call
        // inside `markSessionActive` left the full suite green. This pins
        // that second throat point directly, mirroring the assertions of
        // the `handleSessionAlive` variant above one-for-one.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-revives-via-mark-active',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 31 * 60_000 })
        expect(reaper.sweep()).toEqual([session.id])
        const archivedMeta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(archivedMeta?.lifecycleState).toBe('archived')
        const versionAfterReap = cache.getSession(session.id)?.metadataVersion
        events.length = 0 // drop the reap's own broadcast; only the heal's broadcast matters below

        // Session respawns/resumes for real: `markSessionActive` flips
        // `active` back to `true` via the resume path - per the fix, it
        // heals the archive metadata in the same call, same as
        // `handleSessionAlive` does for keepAlives.
        const reconnectAt = now + 31 * 60_000 + 5_000
        cache.markSessionActive(session.id, reconnectAt)
        expect(cache.getSession(session.id)?.active).toBe(true)

        const healedMeta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(healedMeta?.lifecycleState).toBe('running')
        expect(healedMeta?.archivedBy).toBeUndefined()
        expect(healedMeta?.archiveReason).toBeUndefined()
        expect(cache.getSession(session.id)?.metadataVersion).toBeGreaterThan(versionAfterReap ?? 0)

        const updates = events.filter(
            (event): event is Extract<SyncEvent, { type: 'session-updated' }> =>
                event.type === 'session-updated' && event.sessionId === session.id
        )
        const healBroadcast = updates
            .map((event) => {
                const data = event.data as { metadata?: { value: Record<string, unknown> | null } } | undefined
                return data?.metadata?.value
            })
            .find((value) => value?.lifecycleState === 'running')
        expect(healBroadcast).toBeDefined()

        const laterReaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => reconnectAt + 60 * 60_000 })
        expect(laterReaper.sweep()).toEqual([])
        expect(cache.getSession(session.id)?.active).toBe(true)
    })

    it('does not reap - and does not touch metadata on - a session whose lifecycleState the self-heal already restored to running', () => {
        // No manual CLI-side restamp is needed: `handleSessionAlive` itself
        // performs the heal on reconnect. This pins that a sweep with
        // an aggressively small `staleMs` still leaves the (now genuinely
        // `active: true`) session alone - protection must come from the
        // `active` short-circuit at the top of `sweep()`, not from
        // `lifecycleState` happening to no longer say 'archived'.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const originalNow = Date.now
        const t0 = Date.now()

        const session = cache.getOrCreateSession(
            'session-revived-and-restamped',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        try {
            Date.now = () => t0
            connectThenDisconnect(cache, session.id, t0, t0 + 31_000)

            const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => t0 + 31 * 60_000 })
            expect(reaper.sweep()).toEqual([session.id])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')

            // Reconnect for real, at a later real wall-clock instant. The
            // heal inside `handleSessionAlive` alone restamps lifecycleState.
            const reconnectAt = t0 + 31 * 60_000 + 5_000
            Date.now = () => reconnectAt
            cache.handleSessionAlive({ sid: session.id, time: reconnectAt })
            expect(cache.getSession(session.id)?.active).toBe(true)
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')

            // staleMs: 1 - if the `active` short-circuit were ever dropped,
            // this session (its own `activeAt` is ~1h "old" by the time this
            // later sweep's virtual clock runs) would get reaped again.
            const laterReaper = new SessionReaper(cache, { staleMs: 1, intervalMs: 5 * 60_000, now: () => reconnectAt + 60 * 60_000 })
            expect(laterReaper.sweep()).toEqual([])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
        } finally {
            Date.now = originalNow
        }
    })

    it('leaves a manually-archived session archived across a reconnect (heal only applies to archivedBy === hub-reaper)', () => {
        // A session archived by anything other than this
        // reaper (a human via the web UI, or the CLI's own archive-on-exit
        // path) meant it - reconnecting must never silently undo that.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-manually-archived',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            },
            null,
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now })

        expect(cache.getSession(session.id)?.active).toBe(true)
        const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(meta?.lifecycleState).toBe('archived')
        expect(meta?.archivedBy).toBe('cli')
        expect(meta?.archiveReason).toBe('User terminated')
    })

    it('reconnect-heal is idempotent: repeated keepAlives after healing do not re-write metadata', () => {
        // Idempotency check: the heal's guard re-reads
        // current metadata on every call, so once `lifecycleState` is no
        // longer `'archived'` (whether healed or never archived), further
        // heartbeats must be no-op reads, not repeat writes that would keep
        // bumping `metadataVersion` / `lifecycleStateSince` forever.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-idempotent-heal',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 31 * 60_000 })
        expect(reaper.sweep()).toEqual([session.id])

        const reconnectAt = now + 31 * 60_000 + 5_000
        cache.handleSessionAlive({ sid: session.id, time: reconnectAt })
        const versionAfterHeal = cache.getSession(session.id)?.metadataVersion
        const sinceAfterHeal = (cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined)
            ?.lifecycleStateSince

        // A second keepAlive shortly after must not touch metadata again.
        cache.handleSessionAlive({ sid: session.id, time: reconnectAt + 1_000 })

        expect(cache.getSession(session.id)?.metadataVersion).toBe(versionAfterHeal)
        expect((cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined)?.lifecycleStateSince).toBe(sinceAfterHeal)
        expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
    })

    it('start() runs one sweep immediately but archives nothing: hub downtime is never charged against a session\'s staleness budget', () => {
        // Regression: a hub that was itself down (crash,
        // redeploy, host reboot) longer than `staleMs` used to find every
        // session's last heartbeat already stale the instant it came back up,
        // and its own startup sweep would mass-archive every one of them
        // before they even had a chance to reconnect. Per the fix, disconnect
        // duration is measured from the *later* of `activeAt` and the hub's
        // own most recent `start()` instant - so every session gets a full,
        // fresh `staleMs` reconnect window counted from hub start.
        //
        // Accepted consequence (see reaper.ts's class doc comment): the
        // *immediate* startup sweep can therefore never archive anything on
        // its own - every candidate's disconnect-since collapses to "hub
        // start", i.e. age zero at that exact instant. A genuine startup
        // zombie (CLI never reconnects) is still caught, just by the first
        // periodic sweep that lands after `hub start + staleMs`, pinned via a
        // mutable virtual clock below (no real `start()`/timer wait needed -
        // `sweep()` is called directly at each simulated instant).
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-startup-zombie',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        // Heartbeat already looks 45 minutes stale by wall-clock (past the
        // 30min threshold) - as if the hub had been down that whole time.
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        let clock = now + 45 * 60_000 // hub restarts 45 minutes "later"
        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 3600_000, now: () => clock })
        try {
            reaper.start()
            // Immediate startup sweep: spared, per the accepted semantic change.
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')

            // A periodic sweep still inside the post-restart staleMs window
            // (29 of the allotted 30 minutes since hub start): still spared.
            clock += 29 * 60_000
            expect(reaper.sweep()).toEqual([])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')

            // Past hub-start + staleMs with the CLI still never having
            // reconnected: now it is a genuine startup zombie.
            clock += 2 * 60_000
            expect(reaper.sweep()).toEqual([session.id])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')
        } finally {
            reaper.stop()
        }
    })

    it('a session that reconnects after hub start and disconnects again is judged from that heartbeat, not the hub-start floor', () => {
        // The hub-start floor only ever *raises* the
        // effective disconnect-since for sessions that haven't reconnected
        // yet - once a session genuinely reconnects post-restart and then
        // drops again, its own fresh `activeAt` becomes the later of the two
        // clocks again (`Math.max(activeAt, hubStartedAt)`), and staleness
        // reverts to being judged off that heartbeat exactly as before this
        // fix.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const t0 = Date.now()

        const session = cache.getOrCreateSession(
            'session-reconnects-post-restart',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        // Already looked disconnected before the hub restarted.
        connectThenDisconnect(cache, session.id, t0, t0 + 31_000)

        let clock = t0 + 60 * 60_000 // hub restarts an hour later
        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 3600_000, now: () => clock })
        reaper.start()
        try {
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running') // startup sweep spares it

            // CLI reconnects for real shortly after hub start (heartbeat's
            // `time` must equal real wall-clock "now" for clampAliveTime to
            // accept it verbatim - mock Date.now for just this call, same
            // pattern as the other reconnect-timeline tests in this file).
            clock += 5 * 60_000
            const reconnectAt = clock
            const originalNow = Date.now
            try {
                Date.now = () => reconnectAt
                cache.handleSessionAlive({ sid: session.id, time: reconnectAt })
            } finally {
                Date.now = originalNow
            }
            expect(cache.getSession(session.id)?.active).toBe(true)

            // ...and drops again 31s later (past SessionCache's 30s
            // inactivity timeout).
            clock += 31_000
            expect(cache.expireInactive(clock)).toContain(session.id)

            // 29 minutes after the *reconnect* heartbeat (not 29 minutes
            // after hub start, which was already ~34 minutes ago) - still
            // under staleMs measured from the reconnect: must not reap. A
            // reaper that incorrectly kept anchoring to the original
            // hub-start floor once it had been set would also spare this,
            // for the wrong reason - the next assertion is what actually
            // discriminates the two.
            clock = reconnectAt + 29 * 60_000
            expect(reaper.sweep()).toEqual([])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')

            // Past staleMs measured from the reconnect heartbeat: reaps.
            clock = reconnectAt + 31 * 60_000
            expect(reaper.sweep()).toEqual([session.id])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')
        } finally {
            reaper.stop()
        }
    })

    it('is disabled when constructed with staleMs: 0: start() sweeps nothing, sweep() is a no-op', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-disabled',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 0, intervalMs: 5 * 60_000, now: () => now + 24 * 60 * 60_000 })
        expect(reaper.enabled).toBe(false)
        reaper.start()
        try {
            expect(reaper.sweep()).toEqual([])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
        } finally {
            reaper.stop()
        }
    })

    it('is fully disabled end-to-end via the HAPI_REAPER_STALE_MS=0 environment variable', () => {
        process.env.HAPI_REAPER_STALE_MS = '0'
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-disabled-via-env',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        // No `staleMs` constructor override - must come from the env var.
        const reaper = new SessionReaper(cache, { now: () => now + 24 * 60 * 60_000 })
        expect(reaper.staleMs).toBe(0)
        expect(reaper.enabled).toBe(false)

        reaper.start()
        try {
            expect(reaper.sweep()).toEqual([])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
        } finally {
            reaper.stop()
        }
    })

    it('is fully disabled end-to-end via the HAPI_REAPER_INTERVAL_MS=0 environment variable', () => {
        // Setting either knob to 0 disables the reaper, not just staleMs - a
        // deployment that wants "no periodic sweeping at all" (e.g. it drives
        // sweeps some other way) must be able to zero out the interval alone.
        process.env.HAPI_REAPER_INTERVAL_MS = '0'
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-disabled-via-interval-env',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        // No `intervalMs` constructor override - must come from the env var.
        // `staleMs` stays at its default (30min), which is comfortably below
        // the 31min-stale session above, so a leftover-enabled reaper would
        // still reap it - proving `enabled` really is gated by intervalMs too.
        const reaper = new SessionReaper(cache, { now: () => now + 31 * 60_000 })
        expect(reaper.intervalMs).toBe(0)
        expect(reaper.enabled).toBe(false)

        reaper.start()
        try {
            expect(reaper.sweep()).toEqual([])
            expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
        } finally {
            reaper.stop()
        }
    })

    it('falls back to the default interval/staleness when the env override is not a valid non-negative number', () => {
        // parseNonNegativeIntEnv's contract: garbage or negative input must
        // fall back to the compiled-in default, not silently coerce to NaN/0
        // (0 has the special "disabled" meaning - a typo'd negative value
        // must not accidentally disable the reaper) and not throw.
        process.env.HAPI_REAPER_INTERVAL_MS = 'not-a-number'
        process.env.HAPI_REAPER_STALE_MS = '-500'
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const reaper = new SessionReaper(cache)

        expect(reaper.intervalMs).toBe(REAPER_DEFAULT_INTERVAL_MS)
        expect(reaper.staleMs).toBe(REAPER_DEFAULT_STALE_MS)
        // The default interval is itself 0 (disabled) - a garbage env
        // override falling back to that default therefore still leaves the
        // reaper disabled, not enabled.
        expect(reaper.enabled).toBe(false)
    })

    it('continues sweeping other sessions when one archive attempt throws', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const bad = cache.getOrCreateSession(
            'session-bad',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, bad.id, now, now + 31_000)
        const good = cache.getOrCreateSession(
            'session-good',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, good.id, now, now + 31_000)

        const originalArchive = cache.markSessionArchivedFromHub.bind(cache)
        cache.markSessionArchivedFromHub = ((sessionId: string, reason: string, archivedBy?: string) => {
            if (sessionId === bad.id) {
                throw new Error('simulated write failure')
            }
            return originalArchive(sessionId, reason, archivedBy)
        }) as typeof cache.markSessionArchivedFromHub

        const errors: Array<{ sessionId: string; error: unknown }> = []
        const reaper = new SessionReaper(cache, {
            staleMs: 30 * 60_000,
            intervalMs: 5 * 60_000,
            now: () => now + 60 * 60_000,
            onError: (sessionId, error) => errors.push({ sessionId, error })
        })

        const reaped = reaper.sweep()

        expect(reaped).toEqual([good.id])
        expect(errors).toHaveLength(1)
        expect(errors[0]?.sessionId).toBe(bad.id)
        expect(cache.getSession(bad.id)?.metadata?.lifecycleState).toBe('running')
        expect(cache.getSession(good.id)?.metadata?.lifecycleState).toBe('archived')
    })

    it('the reconnect-heal swallows persistence failures instead of throwing into the keepAlive hot path (deliberately the mirror image of markSessionArchivedFromHub, which throws)', () => {
        // Mutation-coverage gap: `healReaperArchivedSession`
        // deliberately returns instead of throwing on both a hard
        // `{ result: 'error' }` from the store and on exhausted
        // version-mismatch retries - the opposite of `markSessionArchivedFromHub`,
        // which throws on both (see "continues sweeping other sessions when
        // one archive attempt throws" above, and markSessionArchivedFromHub's
        // own doc comment). That reversal is intentional (the heal runs
        // inline in the hot `handleSessionAlive`/`markSessionActive` keepAlive
        // path, where a thrown error would take the connection down with
        // it). This pins the asymmetry so nothing breaks silently if a
        // future edit "fixes" it by making the heal throw like its sibling.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-heal-write-fails',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 31 * 60_000 })
        expect(reaper.sweep()).toEqual([session.id])
        expect(cache.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')
        const versionBeforeReconnect = cache.getSession(session.id)?.metadataVersion

        // Simulate the metadata store failing every write attempt (disk
        // full, corrupted row, genuine contention exhausting all retries -
        // any of these collapse to the same `{ result: 'error' }` /
        // repeated `version-mismatch` shape from the heal's point of view).
        const originalUpdateMetadata = store.sessions.updateSessionMetadata.bind(store.sessions)
        store.sessions.updateSessionMetadata = (() => ({ result: 'error' })) as typeof store.sessions.updateSessionMetadata

        let thrown: unknown
        try {
            cache.handleSessionAlive({ sid: session.id, time: now + 31 * 60_000 + 5_000 })
        } catch (error) {
            thrown = error
        } finally {
            store.sessions.updateSessionMetadata = originalUpdateMetadata
        }

        expect(thrown).toBeUndefined()
        // The heal write failed, but the ordinary active-flag bookkeeping
        // that follows it in `handleSessionAlive` must still run - the CLI
        // really did reconnect even though the metadata heal didn't land.
        expect(cache.getSession(session.id)?.active).toBe(true)
        const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(meta?.lifecycleState).toBe('archived')
        expect(meta?.archivedBy).toBe('hub-reaper')
        expect(cache.getSession(session.id)?.metadataVersion).toBe(versionBeforeReconnect)

        // A later heartbeat, once the store recovers, retries the heal
        // successfully - the failure above was not a permanent lockout.
        cache.handleSessionAlive({ sid: session.id, time: now + 32 * 60_000 })
        const healedMeta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(healedMeta?.lifecycleState).toBe('running')
        expect(healedMeta?.archivedBy).toBeUndefined()
    })

    it('healReaperArchivedSession gives up cleanly, without throwing or corrupting session state, once its version-mismatch retry budget is exhausted', () => {
        // Companion to the immediate-`{ result: 'error' }` case above: here
        // every retry attempt reports version-mismatch (a live contention
        // shape, not a hard failure), so the loop must actually run to its
        // retry cap and only then give up - not spin forever, and not throw
        // into the keepAlive hot path once the cap is hit. The retry cap
        // itself is a private constant in sessionCache.ts (currently 5); this
        // asserts the loop terminates at exactly that many attempts rather
        // than pinning the literal by importing an unexported symbol.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-heal-version-mismatch-exhausted',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' },
            null,
            'default'
        )
        connectThenDisconnect(cache, session.id, now, now + 31_000)

        const reaper = new SessionReaper(cache, { staleMs: 30 * 60_000, intervalMs: 5 * 60_000, now: () => now + 31 * 60_000 })
        expect(reaper.sweep()).toEqual([session.id])
        const archivedMeta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(archivedMeta?.lifecycleState).toBe('archived')
        const versionBeforeReconnect = cache.getSession(session.id)?.metadataVersion

        let updateCalls = 0
        const originalUpdateMetadata = store.sessions.updateSessionMetadata.bind(store.sessions)
        store.sessions.updateSessionMetadata = (() => {
            updateCalls += 1
            // Every attempt loses the race - a live contention shape, distinct
            // from the hard-error case covered above.
            return { result: 'version-mismatch', version: 0, value: null }
        }) as typeof store.sessions.updateSessionMetadata

        let thrown: unknown
        try {
            cache.handleSessionAlive({ sid: session.id, time: now + 31 * 60_000 + 5_000 })
        } catch (error) {
            thrown = error
        } finally {
            store.sessions.updateSessionMetadata = originalUpdateMetadata
        }

        expect(thrown).toBeUndefined()
        expect(updateCalls).toBe(5)
        // Ordinary active-flag bookkeeping (the CLI really did reconnect)
        // still runs even though the metadata heal never landed.
        expect(cache.getSession(session.id)?.active).toBe(true)
        const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
        expect(meta?.lifecycleState).toBe('archived')
        expect(meta?.archivedBy).toBe('hub-reaper')
        expect(cache.getSession(session.id)?.metadataVersion).toBe(versionBeforeReconnect)
    })

    it('falls back to the default interval/staleness when the env override is a float or scientific-notation string', () => {
        // `parseNonNegativeIntEnv`'s numeric coercion (`Number(raw)`) accepts
        // any finite non-negative number, including fractional values and
        // scientific notation - `Number.isFinite` alone does not distinguish
        // "42" from "42.5" or "3e-1". Both intervalMs and staleMs are
        // consumed as whole millisecond durations (`setInterval`, disconnect-
        // age comparisons); a fractional override is malformed input, not a
        // valid one, and must collapse to the compiled-in default exactly
        // like the garbage-string case above rather than silently taking a
        // fractional value.
        process.env.HAPI_REAPER_INTERVAL_MS = '2.5'
        process.env.HAPI_REAPER_STALE_MS = '3e-1'
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const reaper = new SessionReaper(cache)

        expect(reaper.intervalMs).toBe(REAPER_DEFAULT_INTERVAL_MS)
        expect(reaper.staleMs).toBe(REAPER_DEFAULT_STALE_MS)
    })
})
