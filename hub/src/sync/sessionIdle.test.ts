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
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    resolveSessionIdleTimeoutMs,
    shouldClearKeepaliveIdle,
    shouldMarkKeepaliveIdle,
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
        try {
            const dbPath = join(dir, 'hapi.db')
            const store = new Store(dbPath)
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
