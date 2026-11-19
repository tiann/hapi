import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import {
    DEFAULT_SESSION_HIBERNATE_MS,
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    HIBERNATE_ELIGIBLE_FLAVORS,
    hasActiveTeamWork,
    hasLiveWork,
    resolveSessionHibernateMs,
    resolveSessionIdleTimeoutMs,
    shouldClearKeepaliveIdle,
    shouldHibernate,
    shouldMarkKeepaliveIdle,
    type HibernationRunnerCapabilities,
    type HibernationSignals,
} from './sessionIdle'

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 'sid',
        namespace: 'default',
        seq: 0,
        createdAt: NOW - 100 * HOUR,
        updatedAt: NOW - 100 * HOUR,
        active: true,
        activeAt: NOW,
        metadata: { path: '/tmp/p', host: 'h', lifecycleState: 'running' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: NOW,
        ...overrides
    } as Session
}

describe('resolveSessionIdleTimeoutMs', () => {
    it('defaults when unset or unparseable', () => {
        expect(resolveSessionIdleTimeoutMs({})).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS)
        expect(resolveSessionIdleTimeoutMs({ HAPI_SESSION_IDLE_TIMEOUT_MS: '  ' })).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS)
        expect(resolveSessionIdleTimeoutMs({ HAPI_SESSION_IDLE_TIMEOUT_MS: 'soon' })).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS)
        expect(resolveSessionIdleTimeoutMs({ HAPI_SESSION_IDLE_TIMEOUT_MS: '-1' })).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS)
    })

    it('honours an explicit window, and 0 disables', () => {
        expect(resolveSessionIdleTimeoutMs({ HAPI_SESSION_IDLE_TIMEOUT_MS: '3600000' })).toBe(3_600_000)
        expect(resolveSessionIdleTimeoutMs({ HAPI_SESSION_IDLE_TIMEOUT_MS: '0' })).toBe(0)
    })
})

describe('shouldMarkKeepaliveIdle', () => {
    const window = 12 * HOUR

    it('marks a session whose only sign of life is the keepalive', () => {
        expect(shouldMarkKeepaliveIdle(session(), NOW - 87 * HOUR, NOW, window)).toBe(true)
    })

    it('leaves a session inside the window alone', () => {
        expect(shouldMarkKeepaliveIdle(session(), NOW - 2 * HOUR, NOW, window)).toBe(false)
    })

    it('is disabled by a zero window', () => {
        expect(shouldMarkKeepaliveIdle(session(), NOW - 87 * HOUR, NOW, 0)).toBe(false)
    })

    it('never marks work the hub can see', () => {
        const stale = NOW - 87 * HOUR
        expect(shouldMarkKeepaliveIdle(session({ thinking: true }), stale, NOW, window)).toBe(false)
        expect(shouldMarkKeepaliveIdle(session({ backgroundTaskCount: 1 }), stale, NOW, window)).toBe(false)
        expect(shouldMarkKeepaliveIdle(
            session({ agentState: { requests: { 'req-1': { tool: 'Bash', arguments: {} } } } as Session['agentState'] }),
            stale, NOW, window
        )).toBe(false)
    })

    it('honours the explicit escape hatch', () => {
        const exempt = session({ metadata: { path: '/tmp/p', host: 'h', lifecycleState: 'running', idleReconcileExempt: true } })
        expect(shouldMarkKeepaliveIdle(exempt, NOW - 87 * HOUR, NOW, window)).toBe(false)
    })

    it('only touches live running rows', () => {
        const stale = NOW - 87 * HOUR
        expect(shouldMarkKeepaliveIdle(session({ active: false }), stale, NOW, window)).toBe(false)
        expect(shouldMarkKeepaliveIdle(
            session({ metadata: { path: '/tmp/p', host: 'h', lifecycleState: 'archived' } }),
            stale, NOW, window
        )).toBe(false)
        expect(shouldMarkKeepaliveIdle(
            session({ metadata: { path: '/tmp/p', host: 'h' } }),
            stale, NOW, window
        )).toBe(false)
    })
})

describe('shouldClearKeepaliveIdle', () => {
    const window = 12 * HOUR
    const idle = (overrides: Partial<Session> = {}) => session({
        metadata: { path: '/tmp/p', host: 'h', lifecycleState: 'idle' },
        ...overrides
    })

    it('wakes on fresh progress', () => {
        expect(shouldClearKeepaliveIdle(idle(), NOW - 1 * HOUR, NOW, window)).toBe(true)
    })

    it('does not wake on ambient thinking churn (tiann/hapi#1553) — that would flap every tick', () => {
        expect(shouldClearKeepaliveIdle(idle({ thinking: true }), NOW - 87 * HOUR, NOW, window)).toBe(false)
    })

    it('wakes when the escape hatch is set after the fact', () => {
        const exempt = session({ metadata: { path: '/tmp/p', host: 'h', lifecycleState: 'idle', idleReconcileExempt: true } })
        expect(shouldClearKeepaliveIdle(exempt, NOW - 87 * HOUR, NOW, window)).toBe(true)
    })

    it('stays idle while nothing has happened', () => {
        expect(shouldClearKeepaliveIdle(idle(), NOW - 87 * HOUR, NOW, window)).toBe(false)
    })

    it('ignores sessions that are not idle', () => {
        expect(shouldClearKeepaliveIdle(session(), NOW - 1 * HOUR, NOW, window)).toBe(false)
    })
})

describe('SessionCache.reconcileKeepaliveIdle', () => {
    const window = 12 * HOUR

    function setup() {
        const events: SyncEvent[] = []
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher(events))
        const created = cache.getOrCreateSession(
            'tag-1',
            { path: '/tmp/project', host: 'localhost', flavor: 'cursor', lifecycleState: 'running' },
            null,
            'default'
        )
        // The row is stamped "now"; walk the clock forward instead of
        // rewriting persisted timestamps, so `updatedAt` stays honest across
        // the refreshSession that a lifecycle write performs.
        return { store, cache, events, sessionId: created.id, later: Date.now() + 87 * HOUR }
    }

    it('reconciles a keepalive-only session to idle without touching active', () => {
        const { cache, sessionId, later } = setup()

        // 87h of keepalives, nothing else — exactly the #1820 sample.
        cache.handleSessionAlive({ sid: sessionId, time: Date.now() })
        expect(cache.getSession(sessionId)!.active).toBe(true)

        expect(cache.reconcileKeepaliveIdle(later, window)).toEqual([sessionId])

        const marked = cache.getSession(sessionId)!
        expect(marked.metadata?.lifecycleState).toBe('idle')
        // The CLI socket really is up; flipping `active` would arm the
        // resume-respawn / dedup / delete paths against a live process.
        expect(marked.active).toBe(true)
    })

    it('keepalives alone never wake it back up, but agent progress does', () => {
        const { cache, sessionId, later } = setup()
        cache.handleSessionAlive({ sid: sessionId, time: Date.now() })
        cache.reconcileKeepaliveIdle(later, window)
        expect(cache.getSession(sessionId)!.metadata?.lifecycleState).toBe('idle')

        cache.handleSessionAlive({ sid: sessionId, time: Date.now() })
        cache.reconcileKeepaliveIdle(later, window)
        expect(cache.getSession(sessionId)!.metadata?.lifecycleState).toBe('idle')

        cache.recordAgentProgress(sessionId, later)
        cache.reconcileKeepaliveIdle(later, window)
        expect(cache.getSession(sessionId)!.metadata?.lifecycleState).toBe('running')
    })

    it('survives a hub restart: recent assistant output is not read as idle', () => {
        // Needs a file-backed store so the human-turn clock can be backdated
        // directly; `touchSessionUpdatedAt` is forward-only by design.
        const dir = mkdtempSync(join(tmpdir(), 'hapi-1820-'))
        let store: Store | undefined
        try {
            const dbPath = join(dir, 'hapi.db')
            store = new Store(dbPath)
            const cache = new SessionCache(store, createPublisher([]))
            const sessionId = cache.getOrCreateSession(
                'tag-restart',
                { path: '/tmp/project', host: 'localhost', flavor: 'cursor', lifecycleState: 'running' },
                null,
                'default'
            ).id

            // Assistant output just now. This deliberately does NOT move
            // `updatedAt` (sessionHandlers bumps that for human turns only), so
            // the message row is the only durable record of it.
            store.messages.addMessage(
                sessionId,
                { role: 'agent', content: { type: 'text', text: 'still working' } }
            )
            // Last human turn was 80h ago.
            const raw = new Database(dbPath)
            raw.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
                .run(Date.now() - 80 * HOUR, sessionId)
            raw.close()

            // Hub restart: fresh cache over the same store, empty progress map.
            const restarted = new SessionCache(store, createPublisher([]))
            restarted.reloadAll()
            restarted.handleSessionAlive({ sid: sessionId, time: Date.now() })

            // Seeded from the message, not from the 80h-old `updatedAt`.
            expect(restarted.reconcileKeepaliveIdle(Date.now(), window)).toEqual([])
            expect(restarted.getSession(sessionId)!.metadata?.lifecycleState).toBe('running')

            // ...and once that output is itself stale, it does get marked.
            expect(restarted.reconcileKeepaliveIdle(Date.now() + 13 * HOUR, window)).toEqual([sessionId])
            expect(restarted.getSession(sessionId)!.metadata?.lifecycleState).toBe('idle')

        } finally {
            // finally, not a trailing call: a failing assertion above would
            // otherwise leak the temp DB on every run.
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('an assistant message over the socket handler wakes an idle session', () => {
        const { store, cache, sessionId, later } = setup()
        cache.handleSessionAlive({ sid: sessionId, time: Date.now() })
        cache.reconcileKeepaliveIdle(later, window)
        expect(cache.getSession(sessionId)!.metadata?.lifecycleState).toBe('idle')

        // Mirror startHub's wiring: the socket handler's onAgentProgress hook
        // feeds the cache clock. A refactor dropping this would silently
        // false-idle every actively working session.
        const handlers = new Map<string, (payload: unknown) => void>()
        const progress: Array<{ sessionId: string; at: number }> = []
        registerSessionHandlers({
            on: (event: string, handler: (payload: unknown) => void) => {
                handlers.set(event, handler)
            },
            to: () => ({ emit: () => {} })
        } as never, {
            store,
            resolveSessionAccess: (id: string) => {
                const stored = store.sessions.getSessionByNamespace(id, 'default')
                return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
            },
            emitAccessError: () => {},
            onAgentProgress: (id: string, at: number) => {
                progress.push({ sessionId: id, at })
                cache.recordAgentProgress(id, at)
            }
        } as never)

        // An *assistant* message: it never bumps `updatedAt`, so the progress
        // hook is the only thing that can wake the session.
        handlers.get('message')?.({
            sid: sessionId,
            message: JSON.stringify({ role: 'agent', content: { type: 'text', text: 'resumed work' } })
        })
        expect(progress).toHaveLength(1)
        expect(progress[0].sessionId).toBe(sessionId)

        cache.reconcileKeepaliveIdle(progress[0].at + 1 * HOUR, window)
        expect(cache.getSession(sessionId)!.metadata?.lifecycleState).toBe('running')
    })

    it('does nothing when the window is disabled', () => {
        const { cache, sessionId, later } = setup()
        cache.handleSessionAlive({ sid: sessionId, time: Date.now() })

        expect(cache.reconcileKeepaliveIdle(later, 0)).toEqual([])
        expect(cache.getSession(sessionId)!.metadata?.lifecycleState).toBe('running')
    })
})

function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const PBT_ITERATIONS = 500
const PBT_BASE_SEED = Number.parseInt(process.env.HAPI_PBT_SEED ?? '', 10) || (Date.now() >>> 0)

function forAll(name: string, property: (rand: () => number) => void): void {
    for (let i = 0; i < PBT_ITERATIONS; i += 1) {
        const seed = (PBT_BASE_SEED + i) >>> 0
        try {
            property(mulberry32(seed))
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`[pbt] ${name} failed with seed=${seed} (HAPI_PBT_SEED=${seed} to replay): ${message}`)
        }
    }
}

function pick<T>(rand: () => number, items: readonly T[]): T {
    return items[Math.floor(rand() * items.length)]!
}

function randomString(rand: () => number, maxLength = 12): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_ .'
    const length = Math.floor(rand() * (maxLength + 1))
    let out = ''
    for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)]
    return out
}

const CAPABLE: HibernationRunnerCapabilities = { sessionHibernation: true, piExistingSessionResume: true }
const RESUMABLE: HibernationSignals = { resumeId: 'native-1' }
const WINDOW = DEFAULT_SESSION_HIBERNATE_MS

function hibernatable(overrides: Partial<Session> = {}, metadata: Partial<NonNullable<Session['metadata']>> = {}): Session {
    return session({
        metadata: {
            path: '/tmp/p',
            host: 'h',
            lifecycleState: 'running',
            flavor: 'claude',
            startedBy: 'runner',
            machineId: 'machine-1',
            claudeSessionId: 'native-1',
            ...metadata
        },
        ...overrides
    })
}

describe('resolveSessionHibernateMs', () => {
    it('defaults to two hours when unset or unparseable', () => {
        expect(DEFAULT_SESSION_HIBERNATE_MS).toBe(7_200_000)
        expect(resolveSessionHibernateMs({})).toBe(DEFAULT_SESSION_HIBERNATE_MS)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '' })).toBe(DEFAULT_SESSION_HIBERNATE_MS)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: 'abc' })).toBe(DEFAULT_SESSION_HIBERNATE_MS)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '-1' })).toBe(DEFAULT_SESSION_HIBERNATE_MS)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '12abc' })).toBe(DEFAULT_SESSION_HIBERNATE_MS)
    })

    it('treats 0 as disabled and raises tiny windows to one minute', () => {
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '0' })).toBe(0)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: ' 0 ' })).toBe(0)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '1' })).toBe(60_000)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '59999' })).toBe(60_000)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '60000' })).toBe(60_000)
        expect(resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: '3600000' })).toBe(3_600_000)
    })
})

describe('shouldHibernate', () => {
    const stale = NOW - 3 * HOUR

    it('hibernates a keepalive-only runner session past the window', () => {
        expect(shouldHibernate(hibernatable(), RESUMABLE, stale, NOW, WINDOW, CAPABLE)).toBe(true)
        expect(shouldHibernate(hibernatable({}, { lifecycleState: 'idle' }), RESUMABLE, stale, NOW, WINDOW, CAPABLE)).toBe(true)
    })

    it('waits out the full window', () => {
        expect(shouldHibernate(hibernatable(), RESUMABLE, NOW - WINDOW, NOW, WINDOW, CAPABLE)).toBe(false)
        expect(shouldHibernate(hibernatable(), RESUMABLE, NOW - WINDOW - 1, NOW, WINDOW, CAPABLE)).toBe(true)
    })

    it('applies each admission rule', () => {
        const ok = (s: Session, signals: HibernationSignals = RESUMABLE, caps: HibernationRunnerCapabilities = CAPABLE) =>
            shouldHibernate(s, signals, stale, NOW, WINDOW, caps)
        expect(ok(hibernatable({ derivedToolWork: true }))).toBe(false)
        expect(ok(hibernatable({ active: false }))).toBe(false)
        expect(ok(hibernatable({}, { lifecycleState: 'archived' }))).toBe(false)
        expect(ok(hibernatable({}, { lifecycleState: 'hibernated' }))).toBe(false)
        expect(ok(hibernatable({}, { idleReconcileExempt: true }))).toBe(false)
        expect(ok(hibernatable({}, { startedBy: 'terminal' }))).toBe(false)
        expect(ok(hibernatable({}, { startedBy: undefined, startedFromRunner: true }))).toBe(true)
        expect(ok(hibernatable({ agentState: { controlledByUser: true } as Session['agentState'] }))).toBe(false)
        expect(ok(hibernatable({ agentState: { startingMode: 'pty' } as unknown as Session['agentState'] }))).toBe(false)
        expect(ok(hibernatable({}, { startingMode: 'pty' }))).toBe(false)
        expect(ok(hibernatable(), { resumeId: null })).toBe(false)
        expect(ok(hibernatable(), RESUMABLE, { sessionHibernation: false })).toBe(false)
        expect(ok(hibernatable(), RESUMABLE, null)).toBe(false)
    })

    it('applies flavor-specific blockers', () => {
        const ok = (meta: Partial<NonNullable<Session['metadata']>>, caps: HibernationRunnerCapabilities = CAPABLE) =>
            shouldHibernate(hibernatable({}, meta), RESUMABLE, stale, NOW, WINDOW, caps)
        expect(ok({ flavor: 'codex' })).toBe(true)
        expect(ok({ flavor: 'codex', codexRuntime: { kind: 'attached', bindingId: '00000000-0000-4000-8000-000000000000', state: 'attached' } })).toBe(false)
        expect(ok({ flavor: 'codex', codexResumePending: { machineId: 'machine-1', nativeSessionId: 'n' } })).toBe(false)
        expect(ok({ flavor: 'codex', codexArchivedFork: { operationId: '00000000-0000-4000-8000-000000000000', childSessionId: '00000000-0000-4000-8000-000000000001' } })).toBe(false)
        const rewind = { operationId: 'op', nativeSessionId: 'native', workerId: 'worker', requestedLocalId: 'r',
            nativeMessageId: 'm', cutoffSeq: 1, sourceEpoch: 0, sourceMaxSeq: 1, reservationVersion: 1,
            sourceTranscriptHash: '0'.repeat(64) }
        for (const phase of ['reserved', 'prepared', 'unknown', 'committed', 'rejected'] as const) {
            expect(ok({ flavor: 'opencode', opencodeRewind: { ...rewind, phase } })).toBe(phase === 'committed' || phase === 'rejected')
        }
        for (const state of ['aborted', 'reserved'] as const) {
            expect(ok({ flavor: 'opencode', opencodeClearOperation: { replacementSessionId: 'child', state, updatedAt: 1 } }))
                .toBe(state === 'aborted')
        }

        expect(ok({ flavor: 'opencode' })).toBe(true)
        expect(ok({ flavor: 'opencode', opencodeForkPending: true })).toBe(false)
        expect(ok({ flavor: 'pi' })).toBe(true)
        expect(ok({ flavor: 'pi' }, { sessionHibernation: true })).toBe(false)
        expect(ok({ flavor: 'pi', piResumeAttempt: { state: 'resuming', machineId: 'machine-1', startedAt: 1 } })).toBe(false)
        expect(ok({ flavor: 'cursor' })).toBe(false)
        expect(ok({ flavor: 'agy' })).toBe(false)
    })

    it('reads team state as live work', () => {
        expect(hasActiveTeamWork(session({ teamState: { teamName: 't', members: [{ name: 'a', status: 'active' }] } }))).toBe(true)
        expect(hasActiveTeamWork(session({ teamState: { teamName: 't', tasks: [{ id: '1', title: 'x', status: 'in_progress' }] } }))).toBe(true)
        expect(hasActiveTeamWork(session({ teamState: { teamName: 't', members: [{ name: 'a', status: 'idle' }], tasks: [{ id: '1', title: 'x', status: 'completed' }] } }))).toBe(false)
    })
})

describe('hibernation properties (PBT)', () => {
    type LiveWorkField = (s: Session, signals: HibernationSignals, rand: () => number) => void
    const LIVE_WORK: Record<string, LiveWorkField> = {
        thinking: (s) => { s.thinking = true },
        derivedToolWork: (s) => { s.derivedToolWork = true },
        backgroundTasks: (s, _signals, rand) => { s.backgroundTaskCount = 1 + Math.floor(rand() * 5) },
        requests: (s) => { s.agentState = { ...(s.agentState ?? {}), requests: { r: { tool: 'Bash', arguments: {} } } } as Session['agentState'] },
        pendingThinking: (_s, signals) => { signals.pendingThinking = true },
        runningJob: (_s, signals) => { signals.runningJob = true },
        teamWork: (_s, signals) => { signals.activeTeamWork = true },
        terminals: (_s, signals, rand) => { signals.openTerminals = 1 + Math.floor(rand() * 4) },
        undelivered: (_s, signals, rand) => { signals.undeliveredMessages = 1 + Math.floor(rand() * 9) },
        operation: (_s, signals) => { signals.operationInFlight = true },
        controlledByUser: (s) => { s.agentState = { ...(s.agentState ?? {}), controlledByUser: true } as Session['agentState'] },
        exempt: (s) => { s.metadata = { ...s.metadata!, idleReconcileExempt: true } },
    }
    const LIVE_WORK_KEYS = Object.keys(LIVE_WORK)

    function randomCandidate(rand: () => number): { s: Session; signals: HibernationSignals; caps: HibernationRunnerCapabilities } {
        const s = hibernatable({}, {
            flavor: pick(rand, HIBERNATE_ELIGIBLE_FLAVORS),
            lifecycleState: pick(rand, ['running', 'idle'] as const),
            ...(rand() < 0.5 ? { startedBy: 'runner' as const } : { startedBy: undefined, startedFromRunner: true }),
        })
        return { s, signals: { resumeId: `native-${Math.floor(rand() * 1e6)}` }, caps: { ...CAPABLE } }
    }

    it('INVARIANT live work never hibernates', () => {
        forAll('live-work', (rand) => {
            const { s, signals, caps } = randomCandidate(rand)
            const chosen = LIVE_WORK_KEYS.filter(() => rand() < 0.3)
            if (chosen.length === 0) chosen.push(pick(rand, LIVE_WORK_KEYS))
            for (const key of chosen) LIVE_WORK[key]!(s, signals, rand)
            const nonFlagFields = chosen.filter((key) => key !== 'controlledByUser' && key !== 'exempt')
            if (nonFlagFields.length > 0) expect(hasLiveWork(s, signals)).toBe(true)
            expect(shouldHibernate(s, signals, 0, 1e13, 1 + Math.floor(rand() * WINDOW), caps)).toBe(false)
        })
    })

    it('INVARIANT disabled switch never hibernates', () => {
        const fixed = ['0', '-1', ' 0 ', 'abc', '', '  ', '00', '-0', '1e3', '0x10']
        forAll('disabled', (rand) => {
            const raw = rand() < 0.4 ? pick(rand, fixed)
                : rand() < 0.5 ? String(Math.floor(rand() * 200_000) - 100_000)
                    : randomString(rand)
            const resolved = resolveSessionHibernateMs({ HAPI_SESSION_HIBERNATE_MS: raw })
            expect(resolved === 0 || resolved >= 60_000).toBe(true)
            if (raw.trim() === '0' || raw.trim() === '00') expect(resolved).toBe(0)
            const { s, signals, caps } = randomCandidate(rand)
            const disabled = -Math.floor(rand() * 1e9)
            expect(shouldHibernate(s, signals, 0, 1e13, disabled, caps)).toBe(false)
            if (resolved <= 0) expect(shouldHibernate(s, signals, 0, 1e13, resolved, caps)).toBe(false)
        })
    })

    it('INVARIANT monotonic in time', () => {
        forAll('monotonic', (rand) => {
            const { s, signals, caps } = randomCandidate(rand)
            if (rand() < 0.3) LIVE_WORK[pick(rand, LIVE_WORK_KEYS)]!(s, signals, rand)
            if (rand() < 0.2) signals.resumeId = null
            const hibernateMs = 60_000 + Math.floor(rand() * 10 * HOUR)
            const progressAt = Math.floor(rand() * NOW)
            const now1 = progressAt + Math.floor(rand() * 2 * hibernateMs)
            const now2 = now1 + Math.floor(rand() * 100 * HOUR)
            if (shouldHibernate(s, signals, progressAt, now1, hibernateMs, caps)) {
                expect(shouldHibernate(s, signals, progressAt, now2, hibernateMs, caps)).toBe(true)
            }
        })
    })

    it('INVARIANT flavors outside the whitelist never hibernate', () => {
        const known = ['claude', 'codex', 'opencode', 'pi', 'cursor', 'agy', 'gemini', 'grok', 'kimi', 'copilot', 'dsh']
        const whitelist = new Set<string>(HIBERNATE_ELIGIBLE_FLAVORS)
        forAll('flavor-whitelist', (rand) => {
            const flavor = rand() < 0.5 ? pick(rand, known) : randomString(rand)
            const { s, signals, caps } = randomCandidate(rand)
            s.metadata = { ...s.metadata!, flavor }
            const result = shouldHibernate(s, signals, 0, 1e13, WINDOW, caps)
            if (!whitelist.has(flavor)) expect(result).toBe(false)
        })
    })

    it('INVARIANT idle reconciler never touches hibernated sessions', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const ids: string[] = []
        for (let i = 0; i < 4; i += 1) {
            const id = cache.getOrCreateSession(`hib-${i}`, {
                path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'hibernated',
                hibernation: { state: 'hibernated', since: Date.now(), reason: 'idle' },
            }, null, 'default').id
            if (i % 2 === 0) cache.handleSessionAlive({ sid: id, time: Date.now() })
            ids.push(id)
        }
        const versions = new Map(ids.map((id) => [id, cache.getSession(id)!.metadataVersion]))
        forAll('reconciler-hibernated', (rand) => {
            const id = pick(rand, ids)
            if (rand() < 0.3) cache.recordAgentProgress(id, Date.now() + Math.floor(rand() * 1000 * HOUR))
            const clock = Date.now() + Math.floor((rand() * 2 - 0.5) * 1000 * HOUR)
            const window = rand() < 0.1 ? 0 : 1 + Math.floor(rand() * 100 * HOUR)
            cache.reconcileKeepaliveIdle(clock, window)
            for (const sid of ids) {
                const current = cache.getSession(sid)!
                expect(current.metadata?.lifecycleState).toBe('hibernated')
                expect(current.metadataVersion).toBe(versions.get(sid)!)
            }
        })
        store.close()
    })
})
