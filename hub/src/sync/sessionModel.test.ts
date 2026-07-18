import { describe, expect, it } from 'bun:test'
import { AGENT_FLAVORS, getExecutionControl, PROVIDER_CAPABILITIES, PROVIDER_READINESS_MAX_AGE_MS, toSessionSummary } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

function readyMachineMetadata() {
    return {
        host: 'localhost',
        platform: 'linux',
        happyCliVersion: '0.1.0',
        providerReadiness: Object.fromEntries(AGENT_FLAVORS.map((flavor) => {
            const authCheck = flavor === 'grok'
                ? 'credential-file' as const
                : flavor === 'claude' || flavor === 'codex' || flavor === 'cursor'
                    ? 'command' as const
                    : 'unavailable' as const
            return [flavor, {
                status: 'ready' as const,
                installed: true,
                authenticated: authCheck === 'unavailable' ? null : true,
                authCheck,
                version: flavor === 'grok' ? '0.2.101' : '1.2.3',
                ...PROVIDER_CAPABILITIES[flavor],
                checkedAt: Date.now()
            }]
        }))
    }
}

describe('session model', () => {
    it('persists live activity so a store-backed refresh cannot mark a connected session inactive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'session-live-refresh',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const aliveAt = Date.now()

        cache.handleSessionAlive({ sid: session.id, time: aliveAt, thinking: true })

        expect(store.sessions.getSession(session.id)).toMatchObject({
            active: true,
            activeAt: expect.any(Number),
            activityEventAt: aliveAt
        })

        cache.refreshSession(session.id)

        expect(cache.getSession(session.id)).toMatchObject({ active: true, thinking: true })
        expect(cache.getSession(session.id)?.activeAt).toBeGreaterThanOrEqual(aliveAt)
    })

    it('persists live activity independently of frequent thinking broadcasts', () => {
        const originalDateNow = Date.now
        let now = 1_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'session-live-persistence-throttle',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            for (const elapsed of [8_000, 16_000, 24_000, 32_000, 40_000]) {
                now = 1_000_000 + elapsed
                cache.handleSessionAlive({
                    sid: session.id,
                    time: now,
                    thinking: elapsed % 16_000 === 8_000
                })
            }

            const stored = store.sessions.getSession(session.id)
            expect(stored?.active).toBe(true)
            expect(stored?.activeAt).toBeGreaterThanOrEqual(now - 10_000)
        } finally {
            Date.now = originalDateNow
        }
    })

    it('keeps newer Hub liveness in memory without bypassing the persistence throttle', () => {
        const originalDateNow = Date.now
        let now = 1_500_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const cache = new SessionCache(store, createPublisher([]))
            const setSessionActivity = store.sessions.setSessionActivity.bind(store.sessions)
            let activityWrites = 0
            store.sessions.setSessionActivity = (...args) => {
                activityWrites += 1
                return setSessionActivity(...args)
            }
            const session = cache.getOrCreateSession(
                'session-live-refresh-clock',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            const firstHeartbeatAt = now
            cache.handleSessionAlive({ sid: session.id, time: now })
            now += 5_000
            cache.handleSessionAlive({ sid: session.id, time: now })
            cache.refreshSession(session.id)

            expect(activityWrites).toBe(1)
            expect(cache.getSession(session.id)).toMatchObject({ active: true, activeAt: now })
            expect(store.sessions.getSession(session.id)).toMatchObject({
                active: true,
                activeAt: firstHeartbeatAt,
                activityEventAt: firstHeartbeatAt
            })

            now = firstHeartbeatAt + 11_000
            cache.handleSessionAlive({ sid: session.id, time: now })
            expect(activityWrites).toBe(2)
            expect(store.sessions.getSession(session.id)).toMatchObject({
                active: true,
                activeAt: now,
                activityEventAt: now
            })
        } finally {
            Date.now = originalDateNow
        }
    })

    it('repairs a delayed managed stop that is older than a throttled in-memory heartbeat', () => {
        const originalDateNow = Date.now
        let now = 1_750_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession(
                'session-delayed-managed-stop',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    launchNonce: 'launch-1',
                    runnerInstanceId: 'runner-1',
                    lifecycleState: 'running'
                },
                null,
                'default'
            )
            const firstHeartbeatAt = now

            cache.handleSessionAlive({ sid: session.id, time: firstHeartbeatAt })
            now += 5_000
            cache.handleSessionAlive({ sid: session.id, time: now })
            expect(store.sessions.getSession(session.id)?.activityEventAt).toBe(firstHeartbeatAt)

            expect(store.managedSessions.markOutcome({
                namespace: 'default',
                machineId: 'machine-1',
                sessionId: session.id,
                launchNonce: 'launch-1',
                runnerInstanceId: 'runner-1',
                expectedVersion: 1,
                idempotencyKey: 'delayed-stop',
                lifecycleState: 'stopped',
                active: false,
                lifecycleStateSince: firstHeartbeatAt + 1_000
            })).toMatchObject({ result: 'success' })

            cache.refreshSession(session.id)

            expect(cache.getSession(session.id)).toMatchObject({ active: true, activeAt: now })
            expect(store.sessions.getSession(session.id)).toMatchObject({
                active: true,
                activeAt: now,
                activityEventAt: now
            })
        } finally {
            Date.now = originalDateNow
        }
    })

    it('rejects stale alive and end events across persisted activity transitions', () => {
        const originalDateNow = Date.now
        let now = 2_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'session-ordered-activity',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            const base = now

            now = base + 1_000
            cache.handleSessionAlive({ sid: session.id, time: now })
            now = base + 3_000
            cache.handleSessionEnd({ sid: session.id, time: now })
            cache.refreshSession(session.id)
            cache.handleSessionAlive({ sid: session.id, time: base + 2_000 })

            expect(cache.getSession(session.id)?.active).toBe(false)
            expect(store.sessions.getSession(session.id)).toMatchObject({
                active: false,
                activeAt: base + 3_000
            })

            now = base + 4_000
            cache.handleSessionAlive({ sid: session.id, time: now })
            cache.handleSessionEnd({ sid: session.id, time: base + 3_500 })

            expect(cache.getSession(session.id)?.active).toBe(true)
            expect(store.sessions.getSession(session.id)).toMatchObject({
                active: true,
                activeAt: base + 4_000
            })
        } finally {
            Date.now = originalDateNow
        }
    })

    it('persists inactivity expiry so refresh keeps the session offline', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'session-expired-activity',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const aliveAt = Date.now()
        const expiredAt = aliveAt + 31_000

        cache.handleSessionAlive({ sid: session.id, time: aliveAt })
        ;(cache as unknown as { expireInactive: (now: number) => string[] }).expireInactive(expiredAt)
        cache.refreshSession(session.id)

        expect(cache.getSession(session.id)).toMatchObject({
            active: false,
            activeAt: expiredAt
        })
        expect(store.sessions.getSession(session.id)).toMatchObject({
            active: false,
            activeAt: expiredAt
        })
    })

    it('uses Hub time for liveness while ordering transitions by client event time', () => {
        const originalDateNow = Date.now
        let now = 4_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'session-clock-skew',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            cache.handleSessionAlive({ sid: session.id, time: now - 40_000 })

            expect(cache.getSession(session.id)).toMatchObject({ active: true, activeAt: now })
            expect(store.sessions.getSession(session.id)).toMatchObject({ active: true, activeAt: now })
        } finally {
            Date.now = originalDateNow
        }
    })

    it('advances an offline tombstone and ignores invalid stale end events', () => {
        const originalDateNow = Date.now
        let now = 5_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'session-offline-tombstone',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            now += 1_000
            cache.handleSessionAlive({ sid: session.id, time: now })
            now += 2_000
            cache.handleSessionEnd({ sid: session.id, time: now })
            now += 2_000
            cache.handleSessionEnd({ sid: session.id, time: now })
            cache.handleSessionAlive({ sid: session.id, time: now - 1_000 })

            expect(cache.getSession(session.id)?.active).toBe(false)

            now += 11 * 60_000
            cache.handleSessionAlive({ sid: session.id, time: now })
            cache.handleSessionEnd({ sid: session.id, time: now - 11 * 60_000 })

            expect(cache.getSession(session.id)?.active).toBe(true)
        } finally {
            Date.now = originalDateNow
        }
    })

    it('retries an offline transition when the first persistence attempt fails', () => {
        const originalDateNow = Date.now
        let now = 6_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'session-offline-retry',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            cache.handleSessionAlive({ sid: session.id, time: now })

            const setSessionActivity = store.sessions.setSessionActivity.bind(store.sessions)
            store.sessions.setSessionActivity = () => false
            now += 1_000
            cache.handleSessionEnd({ sid: session.id, time: now })
            expect(cache.getSession(session.id)?.active).toBe(true)

            store.sessions.setSessionActivity = setSessionActivity
            cache.handleSessionEnd({ sid: session.id, time: now })

            expect(cache.getSession(session.id)?.active).toBe(false)
            expect(store.sessions.getSession(session.id)?.active).toBe(false)
        } finally {
            Date.now = originalDateNow
        }
    })

    it('fails closed without leaving thinking state when the first active write fails', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'session-first-active-failure',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        store.sessions.setSessionActivity = () => false

        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })

        expect(cache.getSession(session.id)).toMatchObject({ active: false, thinking: false })
        expect(events.some((event) => (
            event.type === 'session-updated'
            && (event.data as { active?: boolean }).active === true
        ))).toBe(false)
    })

    it('retries a failed expiry and allows the next client heartbeat to reactivate', () => {
        const originalDateNow = Date.now
        let now = 6_500_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession(
                'session-expiry-retry',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            const clientAliveAt = now - 40_000
            cache.handleSessionAlive({ sid: session.id, time: clientAliveAt })

            const setSessionActivity = store.sessions.setSessionActivity.bind(store.sessions)
            store.sessions.setSessionActivity = () => false
            now += 31_000
            cache.expireInactive(now)
            expect(cache.getSession(session.id)?.active).toBe(true)

            store.sessions.setSessionActivity = setSessionActivity
            cache.expireInactive(now)
            expect(cache.getSession(session.id)?.active).toBe(false)
            expect(store.sessions.getSession(session.id)?.activityEventAt).toBe(clientAliveAt + 1)

            cache.handleSessionAlive({ sid: session.id, time: clientAliveAt + 31_000 })
            expect(cache.getSession(session.id)?.active).toBe(true)
        } finally {
            Date.now = originalDateNow
        }
    })

    it('lets an end event win over an alive event at the same client timestamp', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const session = cache.getOrCreateSession(
            'session-equal-activity-time',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const eventAt = Date.now()

        cache.handleSessionAlive({ sid: session.id, time: eventAt })
        cache.handleSessionEnd({ sid: session.id, time: eventAt })
        cache.handleSessionAlive({ sid: session.id, time: eventAt })

        expect(cache.getSession(session.id)?.active).toBe(false)
        expect(store.sessions.getSession(session.id)).toMatchObject({ active: false, activityEventAt: eventAt })
    })

    it('preserves future-skewed client ordering instead of replacing it with arrival order', () => {
        const originalDateNow = Date.now
        let now = 7_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession(
                'session-future-skew-order',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            cache.handleSessionEnd({ sid: session.id, time: now + 10_000 })
            now += 1
            cache.handleSessionAlive({ sid: session.id, time: now + 8_999 })

            expect(cache.getSession(session.id)?.active).toBe(false)
            expect(store.sessions.getSession(session.id)?.activityEventAt).toBe(7_010_000)
        } finally {
            Date.now = originalDateNow
        }
    })

    it('keeps memory and store activeAt aligned for a duplicate end event', () => {
        const originalDateNow = Date.now
        let now = 7_500_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession(
                'session-duplicate-end',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            cache.handleSessionAlive({ sid: session.id, time: now })
            now += 1_000
            const endAt = now
            cache.handleSessionEnd({ sid: session.id, time: endAt })
            const storedActiveAt = store.sessions.getSession(session.id)?.activeAt
            expect(storedActiveAt).not.toBeNull()

            now += 60_000
            cache.handleSessionEnd({ sid: session.id, time: endAt })

            expect(cache.getSession(session.id)?.activeAt).toBe(storedActiveAt ?? undefined)
        } finally {
            Date.now = originalDateNow
        }
    })


    it('renames Codex-backed sessions through the synced title field instead of a HAPI-only name', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { eventPublisher: EventPublisher }).eventPublisher = createPublisher(events)

        const session = engine.getOrCreateSession(
            'codex-session',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-1',
                name: 'Old HAPI Name',
                title: 'Old Codex Title'
            },
            null,
            'default',
            'gpt-5.4'
        )

        try {
            await engine.renameSession(session.id, 'New Shared Title')
            const updated = engine.getSession(session.id)

            expect(updated?.metadata?.title).toBe('New Shared Title')
            expect(updated?.metadata?.name).toBeUndefined()
            expect(typeof updated?.metadata?.titleUpdatedAt).toBe('number')
        } finally {
            engine.stop()
        }
    })

    it('archives a session even when the killSession RPC handler is already gone', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { rpcGateway: { killSession: (sessionId: string) => Promise<void> } }).rpcGateway = {
            killSession: async (sessionId: string) => {
                throw new Error(`RPC handler not registered: ${sessionId}:killSession`)
            }
        }

        const session = engine.getOrCreateSession(
            'archive-dead-rpc',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        try {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            await engine.archiveSession(session.id)
            expect(engine.getSession(session.id)?.active).toBe(false)
            expect(engine.getSession(session.id)?.thinking).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('does not mask unexpected archive killSession errors', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { rpcGateway: { killSession: (sessionId: string) => Promise<void> } }).rpcGateway = {
            killSession: async () => {
                throw new Error('permission denied')
            }
        }

        const session = engine.getOrCreateSession(
            'archive-real-error',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        try {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            await expect(engine.archiveSession(session.id)).rejects.toThrow('permission denied')
            expect(engine.getSession(session.id)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('includes explicit model in session summaries', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-summary',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        expect(session.model).toBe('gpt-5.4')
        expect(toSessionSummary(session).model).toBe('gpt-5.4')
        expect(toSessionSummary(session).effort).toBeNull()
    })

    it('includes explicit effort in session summaries', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-summary',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'high'
        )

        expect(session.effort).toBe('high')
        expect(toSessionSummary(session).effort).toBe('high')
    })

    it('persists explicit model reasoning effort on Codex sessions', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-reasoning-effort',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4',
            undefined,
            'xhigh'
        )

        expect(session.modelReasoningEffort).toBe('xhigh')
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBe('xhigh')
    })

    it('persists explicit service tier on Codex sessions', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-service-tier',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.5',
            undefined,
            'xhigh',
            'fast'
        )

        expect(session.serviceTier).toBe('fast')
        expect(store.sessions.getSession(session.id)?.serviceTier).toBe('fast')
    })

    it('preserves model from old session when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-model-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )
        const newSession = cache.getOrCreateSession(
            'session-model-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.model).toBe('gpt-5.4')
    })

    it('does not preserve stale invalid CC-api effort when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-cc-api-effort-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'cc-api' },
            null,
            'default',
            'kimi-k2.7-code',
            'high'
        )
        const newSession = cache.getOrCreateSession(
            'session-cc-api-effort-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'cc-api' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.model).toBe('kimi-k2.7-code')
        expect(merged?.effort).toBeNull()
        expect(store.sessions.getSession(newSession.id)?.effort).toBeNull()
    })

    it('preserves persisted effort for an unlisted CC-api model when merging a resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-custom-cc-api-effort-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'cc-api' },
            null,
            'default',
            'custom-cc-api-model',
            'high'
        )
        const newSession = cache.getOrCreateSession(
            'session-custom-cc-api-effort-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'cc-api' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.model).toBe('custom-cc-api-model')
        expect(merged?.effort).toBe('high')
        expect(store.sessions.getSession(newSession.id)?.effort).toBe('high')
    })

    it('does not preserve stale invalid CC-deepseek effort when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-cc-deepseek-effort-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude-deepseek' },
            null,
            'default',
            'deepseek-v4-flash',
            'medium'
        )
        const newSession = cache.getOrCreateSession(
            'session-cc-deepseek-effort-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude-deepseek' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.model).toBe('deepseek-v4-flash')
        expect(merged?.effort).toBeNull()
        expect(store.sessions.getSession(newSession.id)?.effort).toBeNull()
    })

    it('preserves permissionMode from old session when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-perm-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        store.sessions.setSessionPermissionMode(oldSession.id, 'yolo', 'default')

        const newSession = cache.getOrCreateSession(
            'session-perm-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.permissionMode).toBe('yolo')
        expect(store.sessions.getSession(newSession.id)?.permissionMode).toBe('yolo')
    })

    it('persists applied session permissionMode updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-perm-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )

        cache.applySessionConfig(session.id, { permissionMode: 'bypassPermissions' })
        expect(cache.getSession(session.id)?.permissionMode).toBe('bypassPermissions')
        expect(store.sessions.getSession(session.id)?.permissionMode).toBe('bypassPermissions')
    })

    it('persists keepalive permissionMode to the store so it survives an archived restart', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-perm-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            permissionMode: 'yolo'
        })

        expect(store.sessions.getSession(session.id)?.permissionMode).toBe('yolo')
    })

    it('persists applied session model updates, including clear-to-auto', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.applySessionConfig(session.id, { model: 'opus[1m]' })
        expect(cache.getSession(session.id)?.model).toBe('opus[1m]')
        expect(store.sessions.getSession(session.id)?.model).toBe('opus[1m]')

        cache.applySessionConfig(session.id, { model: null })
        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('persists keepalive model changes, including clearing the model', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            model: null
        })

        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('persists applied session effort updates, including clear-to-auto', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'medium'
        )

        cache.applySessionConfig(session.id, { effort: 'max' })
        expect(cache.getSession(session.id)?.effort).toBe('max')
        expect(store.sessions.getSession(session.id)?.effort).toBe('max')

        cache.applySessionConfig(session.id, { effort: null })
        expect(cache.getSession(session.id)?.effort).toBeNull()
        expect(store.sessions.getSession(session.id)?.effort).toBeNull()
    })

    it('persists applied session model reasoning effort updates, including clear-to-default', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-reasoning-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4',
            undefined,
            'high'
        )

        cache.applySessionConfig(session.id, { modelReasoningEffort: 'xhigh' })
        expect(cache.getSession(session.id)?.modelReasoningEffort).toBe('xhigh')
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBe('xhigh')

        cache.applySessionConfig(session.id, { modelReasoningEffort: null })
        expect(cache.getSession(session.id)?.modelReasoningEffort).toBeNull()
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBeNull()
    })

    it('persists applied session service tier updates, including clear-to-default', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-service-tier-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.5',
            undefined,
            undefined,
            'standard'
        )

        cache.applySessionConfig(session.id, { serviceTier: 'fast' })
        expect(cache.getSession(session.id)?.serviceTier).toBe('fast')
        expect(store.sessions.getSession(session.id)?.serviceTier).toBe('fast')

        cache.applySessionConfig(session.id, { serviceTier: null })
        expect(cache.getSession(session.id)?.serviceTier).toBeNull()
        expect(store.sessions.getSession(session.id)?.serviceTier).toBeNull()
    })

    it('persists keepalive effort changes, including clearing the effort', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'high'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            effort: null
        })

        expect(cache.getSession(session.id)?.effort).toBeNull()
        expect(store.sessions.getSession(session.id)?.effort).toBeNull()
    })

    it('persists keepalive model reasoning effort changes, including clearing the value', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-reasoning-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4',
            undefined,
            'high'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            modelReasoningEffort: null
        })

        expect(cache.getSession(session.id)?.modelReasoningEffort).toBeNull()
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBeNull()
    })

    it('persists keepalive service tier changes, including clearing the value', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-service-tier-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.5',
            undefined,
            undefined,
            'fast'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            serviceTier: null
        })

        expect(cache.getSession(session.id)?.serviceTier).toBeNull()
        expect(store.sessions.getSession(session.id)?.serviceTier).toBeNull()
    })

    it('tracks collaboration mode updates in memory from config and keepalive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-collaboration-mode',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        cache.applySessionConfig(session.id, { collaborationMode: 'plan' })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('plan')

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            collaborationMode: 'default'
        })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('default')
    })

    it('passes the stored model when respawning a resumed session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-model-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedModel: string | undefined
            let capturedModelReasoningEffort: string | undefined
            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                model?: string,
                modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                effort?: string
            ) => {
                capturedModel = model
                capturedModelReasoningEffort = modelReasoningEffort
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedModel).toBe('gpt-5.4')
            expect(capturedModelReasoningEffort).toBeUndefined()
            expect(capturedEffort).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('rejects resume before RPC for missing, stale, non-ready, or resume-disabled readiness', async () => {
        const readyEntry = {
            status: 'ready' as const,
            installed: true,
            authenticated: true,
            authCheck: 'command' as const,
            version: '1.2.3',
            ...PROVIDER_CAPABILITIES.codex,
            checkedAt: Date.now()
        }
        const cases = [
            { name: 'missing metadata', providerReadiness: undefined },
            {
                name: 'stale metadata',
                providerReadiness: {
                    codex: { ...readyEntry, checkedAt: Date.now() - PROVIDER_READINESS_MAX_AGE_MS - 1 }
                }
            },
            {
                name: 'non-ready metadata',
                providerReadiness: {
                    codex: { ...readyEntry, status: 'auth_required' as const, authenticated: false }
                }
            },
            {
                name: 'resume-disabled metadata',
                providerReadiness: {
                    codex: { ...readyEntry, resume: false }
                }
            }
        ]

        for (const testCase of cases) {
            const store = new Store(':memory:')
            const engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never
            )

            try {
                const session = engine.getOrCreateSession(
                    `session-resume-capability-gate-${testCase.name}`,
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-resume-gate'
                    },
                    null,
                    'default',
                    'gpt-5.4'
                )
                engine.getOrCreateMachine(
                    'machine-1',
                    {
                        host: 'localhost',
                        platform: 'linux',
                        happyCliVersion: '0.1.0',
                        providerReadiness: testCase.providerReadiness
                    },
                    null,
                    'default'
                )
                engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
                let spawnCalls = 0
                ;(engine as any).rpcGateway.spawnSession = async () => {
                    spawnCalls += 1
                    return { type: 'success', sessionId: session.id }
                }

                await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                    type: 'error',
                    code: 'resume_unavailable'
                })
                expect(spawnCalls).toBe(0)
            } finally {
                engine.stop()
            }
        }
    })

    it('rejects a DeepSeek resume before RPC when its implicit max effort is not advertised', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-deepseek-implicit-effort-gate',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude-deepseek',
                    claudeSessionId: 'deepseek-thread-implicit-effort'
                },
                null,
                'default'
            )
            const metadata = readyMachineMetadata()
            metadata.providerReadiness['claude-deepseek'] = {
                ...metadata.providerReadiness['claude-deepseek'],
                efforts: { auto: ['auto', 'low', 'medium', 'high'] }
            }
            engine.getOrCreateMachine('machine-1', metadata, null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let spawnCalls = 0
            ;(engine as any).rpcGateway.spawnSession = async () => {
                spawnCalls += 1
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                code: 'resume_unavailable'
            })
            expect(spawnCalls).toBe(0)
        } finally {
            engine.stop()
        }
    })

    it('rejects an unlisted persisted DeepSeek model before resume RPC', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-deepseek-unlisted-model-gate',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude-deepseek',
                    claudeSessionId: 'deepseek-thread-unlisted-model'
                },
                null,
                'default',
                'deepseek-chat'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let spawnCalls = 0
            ;(engine as any).rpcGateway.spawnSession = async () => {
                spawnCalls += 1
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                code: 'resume_unavailable'
            })
            expect(spawnCalls).toBe(0)
        } finally {
            engine.stop()
        }
    })

    it('passes the stored model reasoning effort when respawning a resumed Codex session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-model-reasoning-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4',
                undefined,
                'xhigh'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedModelReasoningEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                modelReasoningEffort?: string
            ) => {
                capturedModelReasoningEffort = modelReasoningEffort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedModelReasoningEffort).toBe('xhigh')
        } finally {
            engine.stop()
        }
    })

    it('passes the stored service tier when respawning a resumed Codex session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-service-tier-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.5',
                undefined,
                undefined,
                'fast'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedServiceTier: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                _permissionMode?: string,
                serviceTier?: string
            ) => {
                capturedServiceTier = serviceTier
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedServiceTier).toBe('fast')
        } finally {
            engine.stop()
        }
    })

    it('passes resume session ID to rpc gateway when resuming claude session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedResumeSessionId: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string
            ) => {
                capturedResumeSessionId = resumeSessionId
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedResumeSessionId).toBe('claude-session-1')
        } finally {
            engine.stop()
        }
    })

    it('resumes a persisted Claude pass-through model that is not in the NewSession preset list', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-pass-through-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-pass-through-thread'
                },
                null,
                'default',
                'opus[1m]',
                'max'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedModel: string | undefined
            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                _resumeSessionId?: string,
                effort?: string
            ) => {
                capturedModel = model
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(capturedModel).toBe('opus[1m]')
            expect(capturedEffort).toBe('max')
        } finally {
            engine.stop()
        }
    })

    it('queries the same pending spawn request instead of treating a late resume webhook as failure', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-pending-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-pending'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            const queryCalls: string[] = []
            ;(engine as any).rpcGateway.spawnSession = async () => ({
                type: 'pending',
                spawnRequestId: '11111111-1111-4111-8111-111111111111'
            })
            ;(engine as any).rpcGateway.querySpawnSession = async (
                _machineId: string,
                spawnRequestId: string
            ) => {
                queryCalls.push(spawnRequestId)
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(queryCalls).toEqual(['11111111-1111-4111-8111-111111111111'])
        } finally {
            engine.stop()
        }
    })

    it('replays the same resume request after an authoritative Runner store miss', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-not-found-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-not-found'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            const spawnRequestIds: string[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnRequestIds.push(args[12] as string)
                return spawnRequestIds.length === 1
                    ? { type: 'pending', spawnRequestId: args[12] as string }
                    : { type: 'success', sessionId: session.id }
            }
            ;(engine as any).rpcGateway.querySpawnSession = async (
                _machineId: string,
                spawnRequestId: string
            ) => ({ type: 'not_found', spawnRequestId })
            ;(engine as any).waitForSessionActive = async () => true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(spawnRequestIds).toHaveLength(2)
            expect(spawnRequestIds[0]).toMatch(/^[0-9a-f-]{36}$/)
            expect(spawnRequestIds[1]).toBe(spawnRequestIds[0])
        } finally {
            engine.stop()
        }
    })

    it('reuses the durable spawn request when a resumed child is not active yet', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-ambiguous-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-ambiguous'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            const spawnRequestIds: string[] = []
            const queriedSpawnRequestIds: string[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnRequestIds.push(args[12] as string)
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).rpcGateway.querySpawnSession = async (
                _machineId: string,
                spawnRequestId: string
            ) => {
                queriedSpawnRequestIds.push(spawnRequestId)
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => queriedSpawnRequestIds.length > 0

            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                message: 'Session failed to become active'
            })
            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })

            expect(spawnRequestIds).toHaveLength(1)
            expect(spawnRequestIds[0]).toMatch(/^[0-9a-f-]{36}$/)
            expect(queriedSpawnRequestIds).toEqual([spawnRequestIds[0]])
        } finally {
            engine.stop()
        }
    })

    it('binds the complete resume operation before the first Runner submission', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-operation-before-submit',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-operation-before-submit'
                },
                null,
                'default',
                'gpt-5.5',
                undefined,
                'xhigh',
                'fast'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            const db = (store.managedSessions as unknown as { db: import('bun:sqlite').Database }).db
            let operationAtSubmission: unknown
            ;(engine as any).rpcGateway.spawnSession = async () => {
                const row = db.prepare(`
                    SELECT spawn_operation_json
                    FROM managed_resume_singleflight
                    WHERE namespace = ? AND canonical_session_id = ?
                `).get('default', session.id) as { spawn_operation_json: string | null }
                operationAtSubmission = row.spawn_operation_json
                    ? JSON.parse(row.spawn_operation_json)
                    : null
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(operationAtSubmission).toEqual({
                version: 1,
                machineId: 'machine-1',
                spawnOptions: {
                    directory: '/tmp/project',
                    agent: 'codex',
                    model: 'gpt-5.5',
                    modelReasoningEffort: 'xhigh',
                    yolo: false,
                    sessionType: 'simple',
                    resumeSessionId: 'codex-operation-before-submit',
                    serviceTier: 'fast'
                }
            })
        } finally {
            engine.stop()
        }
    })

    it('preserves a conflicting resume identity for reconciliation instead of respawning', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-resume-conflict-preserved',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-resume-conflict-preserved'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            const spawnRequestIds: string[] = []
            const queriedSpawnRequestIds: string[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnRequestIds.push(args[12] as string)
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).rpcGateway.querySpawnSession = async (
                _machineId: string,
                spawnRequestId: string
            ) => {
                queriedSpawnRequestIds.push(spawnRequestId)
                return queriedSpawnRequestIds.length === 1
                    ? {
                        type: 'conflict',
                        spawnRequestId,
                        message: `Spawn request '${spawnRequestId}' conflicts with its persisted operation identity`
                    }
                    : { type: 'success', sessionId: session.id }
            }

            let childActive = false
            ;(engine as any).waitForSessionActive = async () => childActive

            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                message: 'Session failed to become active'
            })
            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                code: 'resume_failed',
                message: expect.stringContaining('persisted operation identity')
            })

            childActive = true
            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(spawnRequestIds).toHaveLength(1)
            expect(queriedSpawnRequestIds).toEqual([
                spawnRequestIds[0],
                spawnRequestIds[0]
            ])
        } finally {
            engine.stop()
        }
    })

    it('keeps and queries a reused resume request across a machine outage and stale readiness', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-resume-outage-replay',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-outage-replay'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            const machineCache = (engine as any).machineCache as {
                getOnlineMachinesByNamespace: (namespace: string) => unknown[]
            }
            const getOnlineMachines = machineCache.getOnlineMachinesByNamespace.bind(machineCache)
            let machineOnline = true
            machineCache.getOnlineMachinesByNamespace = (namespace: string) => (
                machineOnline ? getOnlineMachines(namespace) : []
            )

            const spawnRequestIds: string[] = []
            const queryCalls: Array<{ spawnRequestId: string; expectedOptions?: Record<string, unknown> }> = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnRequestIds.push(args[12] as string)
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).rpcGateway.querySpawnSession = async (
                _machineId: string,
                spawnRequestId: string,
                expectedOptions?: Record<string, unknown>
            ) => {
                queryCalls.push({ spawnRequestId, expectedOptions })
                return { type: 'success', sessionId: session.id }
            }

            let childActive = false
            ;(engine as any).waitForSessionActive = async () => childActive

            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                message: 'Session failed to become active'
            })
            expect(spawnRequestIds).toHaveLength(1)

            machineOnline = false
            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                code: 'no_machine_online'
            })

            machineOnline = true
            const targetMachine = getOnlineMachines('default')[0] as {
                metadata?: { providerReadiness?: { claude?: { checkedAt: number } } }
            }
            targetMachine.metadata!.providerReadiness!.claude!.checkedAt = (
                Date.now() - PROVIDER_READINESS_MAX_AGE_MS - 1
            )
            childActive = true
            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })

            expect(spawnRequestIds).toHaveLength(1)
            expect(queryCalls).toEqual([{
                spawnRequestId: spawnRequestIds[0],
                expectedOptions: expect.objectContaining({
                    directory: '/tmp/project',
                    agent: 'claude',
                    model: 'sonnet',
                    resumeSessionId: 'claude-session-outage-replay'
                })
            }])
        } finally {
            engine.stop()
        }
    })

    it('does not retarget a preserved resume request to another same-host machine', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-resume-machine-binding',
                {
                    path: '/tmp/project',
                    host: 'shared-host',
                    machineId: 'machine-a',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-machine-binding'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-a',
                { ...readyMachineMetadata(), host: 'shared-host' },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-b',
                { ...readyMachineMetadata(), host: 'shared-host' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-a', time: Date.now() })
            engine.handleMachineAlive({ machineId: 'machine-b', time: Date.now() })

            const machineCache = (engine as any).machineCache as {
                getOnlineMachinesByNamespace: (namespace: string) => Array<{ id: string }>
            }
            const getOnlineMachines = machineCache.getOnlineMachinesByNamespace.bind(machineCache)
            let onlineMachineIds = new Set(['machine-a', 'machine-b'])
            machineCache.getOnlineMachinesByNamespace = (namespace: string) => (
                getOnlineMachines(namespace).filter((machine) => onlineMachineIds.has(machine.id))
            )

            const spawnCalls: Array<{ machineId: string; spawnRequestId: string }> = []
            const queryCalls: Array<{ machineId: string; spawnRequestId: string }> = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnCalls.push({
                    machineId: args[0] as string,
                    spawnRequestId: args[12] as string
                })
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).rpcGateway.querySpawnSession = async (
                machineId: string,
                spawnRequestId: string
            ) => {
                queryCalls.push({ machineId, spawnRequestId })
                return machineId === 'machine-a'
                    ? { type: 'success', sessionId: session.id }
                    : { type: 'not_found', spawnRequestId }
            }

            let childActive = false
            ;(engine as any).waitForSessionActive = async () => childActive

            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                message: 'Session failed to become active'
            })
            expect(spawnCalls).toHaveLength(1)
            expect(spawnCalls[0]?.machineId).toBe('machine-a')

            onlineMachineIds = new Set(['machine-b'])
            childActive = true
            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                code: 'no_machine_online'
            })
            expect(spawnCalls).toHaveLength(1)
            expect(queryCalls).toHaveLength(0)

            onlineMachineIds = new Set(['machine-a', 'machine-b'])
            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(spawnCalls).toHaveLength(1)
            expect(queryCalls).toEqual([{
                machineId: 'machine-a',
                spawnRequestId: spawnCalls[0]!.spawnRequestId
            }])
        } finally {
            engine.stop()
        }
    })

    it('queries a preserved resume with its original options after session config drift', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-resume-option-binding',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-option-binding'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            const spawnRequestIds: string[] = []
            const queryOptions: Array<Record<string, unknown> | undefined> = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnRequestIds.push(args[12] as string)
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).rpcGateway.querySpawnSession = async (
                _machineId: string,
                spawnRequestId: string,
                expectedOptions?: Record<string, unknown>
            ) => {
                queryOptions.push(expectedOptions)
                return expectedOptions?.model === 'sonnet' && expectedOptions.permissionMode === undefined
                    ? { type: 'success', sessionId: session.id }
                    : { type: 'error', message: `Spawn request '${spawnRequestId}' conflicts with its original options` }
            }

            let childActive = false
            ;(engine as any).waitForSessionActive = async () => childActive

            await expect(engine.resumeSession(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                message: 'Session failed to become active'
            })
            expect(spawnRequestIds).toHaveLength(1)

            ;(engine as any).sessionCache.applySessionConfig(session.id, {
                model: 'opus',
                permissionMode: 'plan'
            })
            childActive = true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(spawnRequestIds).toHaveLength(1)
            expect(queryOptions).toEqual([expect.objectContaining({
                directory: '/tmp/project',
                agent: 'claude',
                model: 'sonnet',
                yolo: false,
                sessionType: 'simple',
                resumeSessionId: 'claude-session-option-binding'
            })])
        } finally {
            engine.stop()
        }
    })



    it('preserves claude-deepseek flavor and Claude resume token when resuming CC-deepseek session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-cc-deepseek-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude-deepseek',
                    claudeSessionId: 'claude-deepseek-session-1'
                },
                null,
                'default',
                'deepseek-v4-pro[1m]',
                'max'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedAgent: string | undefined
            let capturedResumeSessionId: string | undefined
            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string,
                effort?: string
            ) => {
                capturedAgent = agent
                capturedResumeSessionId = resumeSessionId
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedAgent).toBe('claude-deepseek')
            expect(capturedResumeSessionId).toBe('claude-deepseek-session-1')
        } finally {
            engine.stop()
        }
    })

    it('preserves claude-ark flavor and Claude resume token when resuming CC-ark session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-cc-ark-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude-ark',
                    claudeSessionId: 'ark-claude-session-1'
                },
                null,
                'default',
                'doubao-seed-2.0-code',
                'high'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedAgent: string | undefined
            let capturedResumeSessionId: string | undefined
            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string,
                effort?: string
            ) => {
                capturedAgent = agent
                capturedResumeSessionId = resumeSessionId
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedAgent).toBe('claude-ark')
            expect(capturedResumeSessionId).toBe('ark-claude-session-1')
        } finally {
            engine.stop()
        }
    })

    it('preserves cc-api flavor and Claude resume token when resuming CC-api session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-cc-api-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cc-api',
                    claudeSessionId: 'api-claude-session-1'
                },
                null,
                'default',
                'glm-5.2',
                'max'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedAgent: string | undefined
            let capturedResumeSessionId: string | undefined
            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string,
                effort?: string
            ) => {
                capturedAgent = agent
                capturedResumeSessionId = resumeSessionId
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedAgent).toBe('cc-api')
            expect(capturedResumeSessionId).toBe('api-claude-session-1')
            expect(capturedEffort).toBe('max')
        } finally {
            engine.stop()
        }
    })

    it('preserves Hermes MoA flavor and Hermes runtime token when resuming Hermes session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-hermes-moa-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'hermes-moa',
                    hermesSessionId: 'hermes-runtime-session-1'
                },
                null,
                'default',
                'default',
                undefined
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedAgent: string | undefined
            let capturedModel: string | undefined
            let capturedResumeSessionId: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                agent: string,
                model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string
            ) => {
                capturedAgent = agent
                capturedModel = model
                capturedResumeSessionId = resumeSessionId
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedAgent).toBe('hermes-moa')
            expect(capturedModel).toBe('default')
            expect(capturedResumeSessionId).toBe('hermes-runtime-session-1')
        } finally {
            engine.stop()
        }
    })

    it('omits stale invalid CC-api effort when resuming CC-api session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-cc-api-invalid-effort-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cc-api',
                    claudeSessionId: 'api-claude-session-2'
                },
                null,
                'default',
                'kimi-k2.7-code',
                'high'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                effort?: string
            ) => {
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedEffort).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('passes through persisted effort when resuming an unlisted CC-api model', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-custom-cc-api-effort-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cc-api',
                    claudeSessionId: 'custom-api-claude-session-1'
                },
                null,
                'default',
                'custom-cc-api-model',
                'high'
            )
            engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedEffort = args[9] as string | undefined
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            await expect(engine.resumeSession(session.id, 'default')).resolves.toEqual({
                type: 'success',
                sessionId: session.id
            })
            expect(capturedEffort).toBe('high')
        } finally {
            engine.stop()
        }
    })

    it('omits stale invalid CC-deepseek effort when resuming CC-deepseek session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-cc-deepseek-invalid-effort-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude-deepseek',
                    claudeSessionId: 'deepseek-claude-session-2'
                },
                null,
                'default',
                'deepseek-v4-flash',
                'medium'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                effort?: string
            ) => {
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedEffort).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('passes the cached permissionMode when respawning a resumed session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-permission-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-perm'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-1',
                readyMachineMetadata(),
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            engine.handleSessionAlive({
                sid: session.id,
                permissionMode: 'bypassPermissions',
                time: Date.now()
            })
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })

            let capturedPermissionMode: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                permissionMode?: string
            ) => {
                capturedPermissionMode = permissionMode
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedPermissionMode).toBe('bypassPermissions')
        } finally {
            engine.stop()
        }
    })

    describe('session dedup by agent session ID', () => {
        it('merges duplicate when codexSessionId collides', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            // Add a message to s1
            store.messages.addMessage(s1.id, { type: 'text', text: 'hello from s1' }, 'local-1')
            store.deliveryAttempts.append({
                idempotencyKey: 'dedup-attempt', namespace: 'default', canonicalSessionId: s1.id,
                messageId: 'stable-message', attemptId: 'attempt-1', launchNonce: 'launch-1',
                sequence: 1, state: 'prepared', createdAt: 1
            })

            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            expect(s1.id).not.toBe(s2.id)

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeUndefined()
            expect(cache.getSession(s2.id)).toBeDefined()
            expect(store.managedSessions.resolveCanonical('default', s1.id)).toBe(s2.id)
            expect(store.deliveryAttempts.latest('default', s2.id, 'stable-message', 'attempt-1')?.state).toBe('prepared')

            const messages = store.messages.getMessages(s2.id, 100)
            expect(messages.length).toBeGreaterThanOrEqual(1)
        })

        it('preserves sessions with different agent session IDs', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-Y' },
                null,
                'default'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()
        })

        it('does not merge across namespaces', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'ns1'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'ns2'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()
        })

        it('no-op when session has no agent session ID', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            await cache.deduplicateByAgentSessionId(s1.id)

            expect(cache.getSession(s1.id)).toBeDefined()
        })

        it('does not merge active duplicates', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            // Mark s1 as active (simulating a live CLI connection)
            cache.handleSessionAlive({ sid: s1.id, time: Date.now(), thinking: false })

            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            // s1 is active, so it should NOT be merged/deleted
            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()
        })

        it('merges duplicate after it becomes inactive via session-end', async () => {
            const store = new Store(':memory:')
            const engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never
            )

            try {
                const s1 = engine.getOrCreateSession(
                    'tag-1',
                    { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                    null,
                    'default'
                )
                const s2 = engine.getOrCreateSession(
                    'tag-2',
                    { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                    null,
                    'default'
                )

                // Mark s1 as active
                engine.handleSessionAlive({ sid: s1.id, time: Date.now() })

                // s1 is active, dedup from s2 should skip it
                const events: SyncEvent[] = []
                const cache = (engine as any).sessionCache as SessionCache
                await cache.deduplicateByAgentSessionId(s2.id)
                expect(cache.getSession(s1.id)).toBeDefined()
                expect(cache.getSession(s2.id)).toBeDefined()

                // Now s1 ends — handleSessionEnd should trigger dedup retry
                engine.handleSessionEnd({ sid: s1.id, time: Date.now() })

                // Give the fire-and-forget dedup a tick to complete
                await new Promise((r) => setTimeout(r, 50))

                // One of them should be merged away
                const s1Exists = cache.getSession(s1.id)
                const s2Exists = cache.getSession(s2.id)
                expect(!s1Exists || !s2Exists).toBe(true)
            } finally {
                engine.stop()
            }
        })

        it('merges duplicate after inactivity timeout expires it', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            // Mark s1 as active now
            cache.handleSessionAlive({ sid: s1.id, time: Date.now() })

            // s1 is active — dedup skips it
            await cache.deduplicateByAgentSessionId(s2.id)
            expect(cache.getSession(s1.id)).toBeDefined()

            // Simulate time passing beyond the 30s timeout
            const expired = cache.expireInactive(Date.now() + 60_000)
            expect(expired).toContain(s1.id)

            // Now s1 is inactive — dedup should merge it
            await cache.deduplicateByAgentSessionId(s2.id)
            // Exactly one session should survive after dedup; which one is the
            // target depends on activeAt/updatedAt ordering, which can vary by
            // millisecond timing in CI.
            const remaining = [cache.getSession(s1.id), cache.getSession(s2.id)].filter(Boolean)
            expect(remaining).toHaveLength(1)
        })

        it('deep-merges agentState and filters completed requests', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                {
                    requests: {
                        'req-1': { tool: 'Bash', arguments: {} },
                        'req-2': { tool: 'Bash', arguments: {} }
                    },
                    completedRequests: {}
                },
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                {
                    requests: {
                        'req-3': { tool: 'Bash', arguments: {} }
                    },
                    completedRequests: {
                        'req-1': { tool: 'Bash', arguments: {}, status: 'approved' }
                    }
                },
                'default'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            const session = cache.getSession(s2.id)
            expect(session).toBeDefined()
            const state = session!.agentState!

            // req-1 was completed in s2 — should NOT appear in requests
            expect(state.requests?.['req-1']).toBeUndefined()
            // req-2 was an orphan pending in the old (forked-away) session → canceled, not carried forward
            expect(state.requests?.['req-2']).toBeUndefined()
            expect(state.completedRequests?.['req-2']?.status).toBe('canceled')
            // req-3 (the new session's own pending) stays live
            expect(state.requests?.['req-3']).toBeDefined()
            // completedRequests has req-1
            expect(state.completedRequests?.['req-1']).toBeDefined()
        })
    })

    it('takeoverSession spawns a new runner session for an idle desktop mirror', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { eventPublisher: EventPublisher }).eventPublisher = createPublisher(events)
        const runner = engine.getOrCreateSession(
            'runner-session',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-1',
                executionControl: {
                    owner: 'desktop-sync',
                    generation: 99,
                    leaseExpiresAt: null,
                    runnerSessionId: null,
                    updatedAt: 99
                }
            },
            null,
            'default',
            'gpt-5.4'
        )
        const rpcGateway = {
            spawnSession: async () => ({ type: 'success' as const, sessionId: runner.id })
        }
        ;(engine as unknown as { rpcGateway: typeof rpcGateway }).rpcGateway = rpcGateway
        const mirror = engine.getOrCreateSession(
            'desktop-mirror',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                codexSessionId: 'thread-1',
                executionControl: {
                    owner: 'desktop-sync',
                    generation: 7,
                    leaseExpiresAt: null,
                    runnerSessionId: null,
                    updatedAt: 7
                }
            },
            null,
            'default',
            'gpt-5.4'
        )
        engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
        engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
        const sessionCache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
        const actualPatchSessionMetadata = sessionCache.patchSessionMetadata.bind(sessionCache)
        let patchAttempts = 0
        sessionCache.patchSessionMetadata = async (sessionId, namespace, updater) => {
            patchAttempts += 1
            if (patchAttempts === 1) {
                await actualPatchSessionMetadata(sessionId, namespace, (current) => ({
                    ...current,
                    name: 'runner updated concurrently'
                }))
                throw new Error('Session was modified concurrently. Please try again.')
            }
            return actualPatchSessionMetadata(sessionId, namespace, updater)
        }

        mirror.active = true
        mirror.thinking = false
        ;(engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => true

        try {
            const result = await engine.takeoverSession(mirror.id, 'default')
            const canonical = engine.getSession(runner.id)
            const control = getExecutionControl(canonical?.metadata)

            expect(result).toEqual({ type: 'success', sessionId: runner.id })
            expect(canonical?.metadata?.mirrorSource).toBe('codex-desktop-sync')
            expect(control).toMatchObject({
                owner: 'hapi-runner',
                generation: 8,
                runnerSessionId: runner.id
            })
            expect(canonical?.metadata?.name).toBe('runner updated concurrently')
            expect(typeof control?.leaseExpiresAt).toBe('number')
            expect((control?.leaseExpiresAt ?? 0) > Date.now()).toBe(true)
            expect(patchAttempts).toBe(3)
        } finally {
            engine.stop()
        }
    })

    it('takeoverSession is idempotent for an active mirror already owned by hapi-runner', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { eventPublisher: EventPublisher }).eventPublisher = createPublisher(events)
        const spawnCalls: string[] = []
        const rpcGateway = {
            spawnSession: async () => {
                spawnCalls.push('spawn')
                return { type: 'success', sessionId: 'unexpected-runner' as const }
            }
        }
        ;(engine as unknown as { rpcGateway: typeof rpcGateway }).rpcGateway = rpcGateway
        const mirror = engine.getOrCreateSession(
            'desktop-mirror-owned-by-runner',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                codexSessionId: 'thread-1',
                executionControl: {
                    owner: 'hapi-runner',
                    generation: 8,
                    leaseExpiresAt: Date.now() + 60_000,
                    runnerSessionId: 'runner-session',
                    updatedAt: 8
                }
            },
            null,
            'default',
            'gpt-5.4'
        )

        mirror.active = true
        mirror.thinking = false

        try {
            const result = await engine.takeoverSession(mirror.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: mirror.id })
            expect(spawnCalls).toEqual([])
        } finally {
            engine.stop()
        }
    })

    it('takeoverSession acquires runner ownership even when the desktop mirror had no prior execution control', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { eventPublisher: EventPublisher }).eventPublisher = createPublisher(events)
        const runner = engine.getOrCreateSession(
            'runner-session-no-control',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-no-control'
            },
            null,
            'default',
            'gpt-5.4'
        )
        const rpcGateway = {
            spawnSession: async () => ({ type: 'success' as const, sessionId: runner.id })
        }
        ;(engine as unknown as { rpcGateway: typeof rpcGateway }).rpcGateway = rpcGateway
        const mirror = engine.getOrCreateSession(
            'desktop-mirror-no-control',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                codexSessionId: 'thread-no-control'
            },
            null,
            'default',
            'gpt-5.4'
        )
        engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
        engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
        mirror.active = true
        mirror.thinking = false
        ;(engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => true

        try {
            const result = await engine.takeoverSession(mirror.id, 'default')
            const canonical = engine.getSession(runner.id)
            const control = getExecutionControl(canonical?.metadata)

            expect(result).toEqual({ type: 'success', sessionId: runner.id })
            expect(canonical?.metadata?.mirrorSource).toBe('codex-desktop-sync')
            expect(control).toMatchObject({
                owner: 'hapi-runner',
                generation: 1,
                runnerSessionId: runner.id
            })
            expect(typeof control?.leaseExpiresAt).toBe('number')
            expect((control?.leaseExpiresAt ?? 0) > Date.now()).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('takeoverSession treats recent desktop-sync messages as a desktop mirror even without metadata', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { eventPublisher: EventPublisher }).eventPublisher = createPublisher(events)
        const runner = engine.getOrCreateSession(
            'runner-session-message-only',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-message-only'
            },
            null,
            'default',
            'gpt-5.4'
        )
        const rpcGateway = {
            spawnSession: async () => ({ type: 'success' as const, sessionId: runner.id })
        }
        ;(engine as unknown as { rpcGateway: typeof rpcGateway }).rpcGateway = rpcGateway
        const mirror = engine.getOrCreateSession(
            'desktop-mirror-message-only',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-message-only'
            },
            null,
            'default',
            'gpt-5.4'
        )
        store.messages.addMessage(mirror.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: 'mirrored from desktop'
                }
            },
            meta: {
                sentFrom: 'codex-desktop-sync'
            }
        })
        engine.getOrCreateMachine('machine-1', readyMachineMetadata(), null, 'default')
        engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
        mirror.active = true
        mirror.thinking = false
        ;(engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => true

        try {
            const result = await engine.takeoverSession(mirror.id, 'default')
            const canonical = engine.getSession(runner.id)
            const control = getExecutionControl(canonical?.metadata)

            expect(result).toEqual({ type: 'success', sessionId: runner.id })
            expect(canonical?.metadata?.mirrorSource).toBe('codex-desktop-sync')
            expect(control).toMatchObject({
                owner: 'hapi-runner',
                generation: 1,
                runnerSessionId: runner.id
            })
        } finally {
            engine.stop()
        }
    })

    it('releases runner ownership on session end so desktop sync can resume', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { eventPublisher: EventPublisher }).eventPublisher = createPublisher(events)
        const session = engine.getOrCreateSession(
            'session-runner',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-1',
                mirrorSource: 'codex-desktop-sync',
                executionControl: {
                    owner: 'hapi-runner',
                    generation: 2,
                    leaseExpiresAt: Date.now() + 60_000,
                    runnerSessionId: 'session-runner',
                    updatedAt: Date.now()
                }
            },
            null,
            'default'
        )

        engine.handleSessionEnd({ sid: session.id, time: Date.now(), source: 'cli' })

        const updated = engine.getSession(session.id)
        expect((updated?.metadata as { executionControl?: { owner?: string; generation?: number } }).executionControl?.owner).toBe('desktop-sync')
        expect((updated?.metadata as { executionControl?: { owner?: string; generation?: number } }).executionControl?.generation).toBe(3)
    })

    it('does not release runner ownership for a stale rejected session end', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, null as never, new RpcRegistry(), { broadcast() {} } as never)
        const now = Date.now()
        const session = engine.getOrCreateSession(
            'session-runner-stale-end',
            {
                path: '/tmp/project', host: 'localhost', flavor: 'codex',
                executionControl: {
                    owner: 'hapi-runner', generation: 2, leaseExpiresAt: now + 60_000,
                    runnerSessionId: 'session-runner-stale-end', updatedAt: now
                }
            },
            null,
            'default'
        )
        engine.handleSessionAlive({ sid: session.id, time: now })

        engine.handleSessionEnd({ sid: session.id, time: now - 11 * 60_000, source: 'cli' })

        expect(engine.getSession(session.id)?.active).toBe(true)
        expect(getExecutionControl(engine.getSession(session.id)?.metadata)?.owner).toBe('hapi-runner')
        engine.stop()
    })

    it('does not release runner ownership when the store already has a newer inactive event', () => {
        const originalDateNow = Date.now
        let now = 8_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const engine = new SyncEngine(store, null as never, new RpcRegistry(), { broadcast() {} } as never)
            const session = engine.getOrCreateSession(
                'session-runner-newer-store-end',
                {
                    path: '/tmp/project', host: 'localhost', flavor: 'codex',
                    executionControl: {
                        owner: 'hapi-runner', generation: 2, leaseExpiresAt: now + 60_000,
                        runnerSessionId: 'session-runner-newer-store-end', updatedAt: now
                    }
                },
                null,
                'default'
            )
            engine.handleSessionAlive({ sid: session.id, time: now })
            expect(store.sessions.setSessionActivity(session.id, false, now, now + 200, 'default')).toBe(true)

            engine.handleSessionEnd({ sid: session.id, time: now + 100, source: 'cli' })

            expect(getExecutionControl(engine.getSession(session.id)?.metadata)?.owner).toBe('hapi-runner')
            engine.stop()
        } finally {
            Date.now = originalDateNow
        }
    })

    it('releases stale runner ownership for inactive desktop mirrors during the inactivity sweep', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(
            store,
            null as never,
            new RpcRegistry(),
            { broadcast: () => undefined } as never
        )
        ;(engine as unknown as { eventPublisher: EventPublisher }).eventPublisher = createPublisher(events)
        const now = Date.now()
        const session = engine.getOrCreateSession(
            'session-runner-stale-lease',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-1',
                mirrorSource: 'codex-desktop-sync',
                executionControl: {
                    owner: 'hapi-runner',
                    generation: 4,
                    leaseExpiresAt: now + 10 * 60_000,
                    runnerSessionId: 'session-runner-stale-lease',
                    updatedAt: now
                }
            },
            null,
            'default'
        )

        expect(getExecutionControl(engine.getSession(session.id)?.metadata)?.owner).toBe('hapi-runner')

        await (engine as unknown as { expireInactive: () => Promise<void> }).expireInactive()

        const updated = engine.getSession(session.id)
        expect((updated?.metadata as { executionControl?: { owner?: string; generation?: number } }).executionControl?.owner).toBe('desktop-sync')
        expect((updated?.metadata as { executionControl?: { owner?: string; generation?: number } }).executionControl?.generation).toBe(5)
    })

    it('mergeSessions preserves desktop mirror execution control metadata needed for takeover', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const mirror = cache.getOrCreateSession(
            'desktop-mirror-merge-source',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                codexSessionId: 'thread-1',
                executionControl: {
                    owner: 'desktop-sync',
                    generation: 7,
                    leaseExpiresAt: null,
                    runnerSessionId: null,
                    updatedAt: 7
                }
            },
            null,
            'default',
            'gpt-5.4'
        )
        const runner = cache.getOrCreateSession(
            'desktop-mirror-merge-target',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                codexSessionId: 'thread-1'
            },
            null,
            'default',
            'gpt-5.4'
        )

        await cache.mergeSessions(mirror.id, runner.id, 'default')

        const merged = cache.getSession(runner.id)
        expect(merged?.metadata?.mirrorSource).toBe('codex-desktop-sync')
        expect(getExecutionControl(merged?.metadata)).toEqual({
            owner: 'desktop-sync',
            generation: 7,
            leaseExpiresAt: null,
            runnerSessionId: null,
            updatedAt: 7
        })
    })

    it('mergeSessions keeps the higher-generation runner ownership when target already has stale mirror control', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const mirror = cache.getOrCreateSession(
            'desktop-mirror-merge-source-owned',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                codexSessionId: 'thread-2',
                executionControl: {
                    owner: 'hapi-runner',
                    generation: 8,
                    leaseExpiresAt: 123456,
                    runnerSessionId: 'runner-session-2',
                    updatedAt: 8
                }
            },
            null,
            'default',
            'gpt-5.4'
        )
        const runner = cache.getOrCreateSession(
            'desktop-mirror-merge-target-stale',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                codexSessionId: 'thread-2',
                executionControl: {
                    owner: 'desktop-sync',
                    generation: 1,
                    leaseExpiresAt: null,
                    runnerSessionId: null,
                    updatedAt: 1
                }
            },
            null,
            'default',
            'gpt-5.4'
        )

        await cache.mergeSessions(mirror.id, runner.id, 'default')

        const merged = cache.getSession(runner.id)
        expect(merged?.metadata?.mirrorSource).toBe('codex-desktop-sync')
        expect(getExecutionControl(merged?.metadata)).toEqual({
            owner: 'hapi-runner',
            generation: 8,
            leaseExpiresAt: 123456,
            runnerSessionId: 'runner-session-2',
            updatedAt: 8
        })
    })


    it('rejects session config when the active CLI returns an old model reasoning effort', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-config-stale-reasoning-effort',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default',
                'gpt-5.5',
                undefined,
                'xhigh'
            )
            ;(engine as unknown as {
                rpcGateway: { requestSessionConfig: () => Promise<unknown> }
            }).rpcGateway = {
                requestSessionConfig: async () => ({
                    applied: { modelReasoningEffort: 'xhigh' }
                })
            }

            await expect(engine.applySessionConfig(session.id, { modelReasoningEffort: 'high' }))
                .rejects.toThrow('Session config was not applied')
            expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBe('xhigh')
        } finally {
            engine.stop()
        }
    })


    it('rejects session config when the active CLI omits requested service tier', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-config-stale-service-tier',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default',
                'gpt-5.5',
                undefined,
                undefined,
                'standard'
            )
            ;(engine as unknown as {
                rpcGateway: { requestSessionConfig: () => Promise<unknown> }
            }).rpcGateway = {
                requestSessionConfig: async () => ({
                    applied: {}
                })
            }

            await expect(engine.applySessionConfig(session.id, { serviceTier: 'fast' }))
                .rejects.toThrow('Session config was not applied')
            expect(store.sessions.getSession(session.id)?.serviceTier).toBe('standard')
        } finally {
            engine.stop()
        }
    })

})
