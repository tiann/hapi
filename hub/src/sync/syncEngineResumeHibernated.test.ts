import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { HISTORY_ACTION_IN_PROGRESS_MESSAGE, SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'
import type { SessionCache } from './sessionCache'
import type { WebAppEnv } from '../web/middleware/auth'
import { createMessagesRoutes } from '../web/routes/messages'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'

const HOUR = 60 * 60 * 1000
const WINDOW = 2 * HOUR
const NAMESPACE = 'default'
const MACHINE = 'machine-1'

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

async function forAll(name: string, property: (rand: () => number, iteration: number) => Promise<void>): Promise<void> {
    for (let i = 0; i < PBT_ITERATIONS; i += 1) {
        const seed = (PBT_BASE_SEED + i) >>> 0
        try {
            await property(mulberry32(seed), i)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`[pbt] ${name} failed with seed=${seed} (HAPI_PBT_SEED=${seed} to replay): ${message}`)
        }
    }
}

function pick<T>(rand: () => number, items: readonly T[]): T {
    return items[Math.floor(rand() * items.length)]!
}

const ioStub = { of: () => ({ to: () => ({ emit() {} }) }) }

describe('SyncEngine resume of hibernated sessions', () => {
    let store: Store
    let engine: SyncEngine
    let stopCalls: string[]
    let mergeCalls: number
    let spawnImpl: (sessionId: string) => Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }>

    let nextPid = 1000
    function cache(): SessionCache {
        return (engine as unknown as { sessionCache: SessionCache }).sessionCache
    }

    function gateway(): Record<string, unknown> {
        return (engine as unknown as { rpcGateway: Record<string, unknown> }).rpcGateway
    }

    function bootCli(sid: string): void {
        const stored = store.sessions.getSession(sid)
        if (stored) {
            store.sessions.updateSessionMetadata(sid, {
                ...(stored.metadata as object), lifecycleState: 'running', lifecycleStateSince: Date.now()
            }, stored.metadataVersion, NAMESPACE, { touchUpdatedAt: false })
            cache().refreshSession(sid)
        }
        engine.handleSessionAlive({ sid, time: Date.now() })
    }

    async function hibernatedSession(tag: string, flavor: 'claude' | 'codex' | 'pi' = 'claude'): Promise<string> {
        const id = cache().getOrCreateSession(tag, {
            path: '/tmp/project',
            host: 'localhost',
            flavor,
            startedBy: 'runner',
            hostPid: ++nextPid,
            hostStartMarker: `gen-${nextPid}`,
            startedFromRunner: true,
            machineId: MACHINE,
            [`${flavor}SessionId`]: `native-${tag}`,
            lifecycleState: 'running',
        }, null, NAMESPACE).id
        engine.handleSessionAlive({ sid: id, time: Date.now() })
        expect(await engine.hibernateSession(id, { now: Date.now() + 3 * HOUR, hibernateMs: WINDOW })).toBe('hibernated')
        stopCalls.length = 0
        return id
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, ioStub as never, new RpcRegistry(), { broadcast() {} } as never)
        stopCalls = []
        mergeCalls = 0
        engine.getOrCreateMachine(MACHINE, { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            { status: 'running', capabilities: { sessionHibernation: true, piExistingSessionResume: true } }, NAMESPACE)
        engine.handleMachineAlive({ machineId: MACHINE, time: Date.now() })
        gateway().stopRunnerSession = async (_machineId: string, sessionId: string) => {
            stopCalls.push(sessionId)
            if (cache().getSession(sessionId)?.active) engine.handleSessionEnd({ sid: sessionId, time: Date.now() })
            return 'stopped'
        }
        gateway().killSession = async () => { throw new RpcTargetMissingError('KillSession', 'handler-not-registered') }
        spawnImpl = async (sessionId) => {
            bootCli(sessionId)
            return { type: 'success', sessionId }
        }
        gateway().spawnSession = async (...args: unknown[]) => await spawnImpl(args[12] as string)
        cache().mergeSessions = async () => { mergeCalls += 1 }
        // Readiness polling is not under test; resolve it from the cache.
        ;(engine as unknown as { waitForSessionActive: (sid: string) => Promise<boolean> }).waitForSessionActive =
            async (sid: string) => cache().getSession(sid)?.active === true
    })

    afterEach(() => {
        engine.stop()
    })

    it('resumes under the same id, clears the marker and does not re-hibernate within a window', async () => {
        const id = await hibernatedSession('same-id')
        const result = await engine.resumeSession(id, NAMESPACE)
        expect(result).toEqual({ type: 'success', sessionId: id })
        const session = cache().getSession(id)!
        expect(session.active).toBe(true)
        expect(session.metadata?.lifecycleState).toBe('running')
        expect(session.metadata?.hibernation).toBeUndefined()
        expect(engine.getHibernationProgressAt(session)).toBeGreaterThan(Date.now() - 60_000)

        expect(await engine.hibernateIdleSessions(Date.now() + WINDOW / 2, WINDOW)).toEqual([])
        expect(cache().getSession(id)!.active).toBe(true)
    })

    it('clears a settled wake marker and backoff on reopening an already connected session', async () => {
        const id = await hibernatedSession('active-reopen')
        bootCli(id)
        const backoff = (engine as unknown as { hibernateWakeBackoffUntil: Map<string, number> }).hibernateWakeBackoffUntil
        backoff.set(id, Infinity)
        expect(cache().getSession(id)?.metadata?.hibernation?.state).toBe('hibernated')
        expect(await engine.reopenSession(id, NAMESPACE)).toEqual({ type: 'success', sessionId: id, resumed: false })
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
        expect(backoff.has(id)).toBe(false)
    })

    it('reopens the same session after an in-flight hibernation finishes', async () => {
        const id = await hibernatedSession('reopen-during-stop')
        await engine.resumeSession(id, NAMESPACE)
        let release!: () => void
        const paused = new Promise<void>(resolve => { release = resolve })
        gateway().stopRunnerSession = async () => {
            await paused
            engine.handleSessionEnd({ sid: id, time: Date.now() })
            return 'stopped'
        }
        const stopping = engine.hibernateSession(id, { now: Date.now() + 3 * HOUR, hibernateMs: WINDOW })
        expect(engine.hibernationInFlight(id)).toBe(true)
        const reopening = engine.reopenSession(id, NAMESPACE)
        release()
        expect(await stopping).toBe('hibernated')
        expect(await reopening).toEqual({ type: 'success', sessionId: id, resumed: true })
        expect(cache().getSession(id)?.active).toBe(true)
    })

    it.each(['claude', 'codex', 'pi'] as const)('rejects an unverified mismatched id from a %s wake', async flavor => {
        const id = await hibernatedSession('different-id', flavor)
        spawnImpl = async () => {
            const stray = cache().getOrCreateSession('stray', { path: '/tmp/project', host: 'localhost', flavor: 'claude', machineId: MACHINE }, null, NAMESPACE).id
            engine.handleSessionAlive({ sid: stray, time: Date.now() })
            return { type: 'success', sessionId: stray }
        }
        const result = await engine.resumeSession(id, NAMESPACE)
        expect(result.type).toBe('error')
        if (result.type === 'error') expect(result.code).toBe('resume_failed')
        expect(stopCalls).toEqual([])
        if (flavor === 'codex') expect(cache().getSession(id)?.metadata?.codexResumePending?.machineId).toBe(MACHINE)
        expect(mergeCalls).toBe(0)
        expect(cache().getSession(id)!.metadata?.lifecycleState).toBe('hibernated')
    })

    it.each([['default', MACHINE], ['foreign', MACHINE], ['default', 'other-machine']])(
        'preserves a pre-existing mismatched row in namespace %s on machine %s', async (namespace, machineId) => {
            const id = await hibernatedSession('owned')
            const other = cache().getOrCreateSession('another', { path: '/tmp', host: 'h', machineId }, null, namespace)
            engine.handleSessionAlive({ sid: other.id, time: Date.now() })
            const before = store.sessions.getSession(other.id)
            spawnImpl = async () => ({ type: 'success', sessionId: other.id })
            expect(await engine.resumeSession(id, NAMESPACE)).toMatchObject({ type: 'error', code: 'resume_failed' })
            expect(stopCalls).toEqual([])
            expect(store.sessions.getSession(other.id)).toEqual(before)
        }
    )

    it('preserves a concurrently created row and leaves wakes manual-only until a real resume', async () => {
        const id = await hibernatedSession('stray-delete')
        let strayId = ''
        spawnImpl = async () => {
            strayId = cache().getOrCreateSession('stray-delete-child', { path: '/tmp/project', host: 'localhost', flavor: 'claude', machineId: MACHINE }, null, NAMESPACE).id
            engine.handleSessionAlive({ sid: strayId, time: Date.now() })
            return { type: 'success', sessionId: strayId }
        }
        const result = await engine.resumeSession(id, NAMESPACE)
        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(stopCalls).toEqual([])
        expect(cache().getSession(strayId)?.active).toBe(true)
        expect(store.sessions.getSession(strayId)).not.toBeNull()
        expect(cache().getSession(id)!.metadata?.lifecycleState).toBe('hibernated')

        store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'due' } }, 'local-due', Date.now() + 1_000)
        let spawns = 0
        spawnImpl = async (sessionId) => { spawns += 1; bootCli(sessionId); return { type: 'success', sessionId } }
        const wake = (engine as unknown as { wakeHibernatedForMatureScheduled: (now: number) => void })
            .wakeHibernatedForMatureScheduled.bind(engine)
        for (const offset of [5_000, 11 * 60_000, 24 * HOUR]) {
            wake(Date.now() + offset)
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(spawns).toBe(0)

        // A user / peer / web resume still goes through and lifts the hold.
        expect(await engine.resumeSession(id, NAMESPACE)).toEqual({ type: 'success', sessionId: id })
        expect(spawns).toBe(1)
        const backoff = (engine as unknown as { hibernateWakeBackoffUntil: Map<string, number> }).hibernateWakeBackoffUntil
        expect(backoff.has(id)).toBe(false)
    })

    it('preserves a local Claude resume and its subsequent normal CLI archive', async () => {
        const id = await hibernatedSession('local-resume')
        const publish = (patch: object) => {
            const stored = store.sessions.getSession(id)!
            store.sessions.updateSessionMetadata(id, { ...(stored.metadata as object), ...patch }, stored.metadataVersion, NAMESPACE)
            cache().refreshSession(id)
        }
        publish({ startedBy: 'terminal', startedFromRunner: false, hostPid: 4321,
            lifecycleState: 'running', lifecycleStateSince: Date.now() })
        engine.handleSessionAlive({ sid: id, time: Date.now(), mode: 'local' })
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
        publish({ lifecycleState: 'archived', archivedBy: 'cli' })
        engine.handleSessionEnd({ sid: id, time: Date.now() })
        expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('archived')
    })

    it('keeps the hub-owned marker until resume succeeds and re-hibernates if the woken CLI exits first', async () => {
        const id = await hibernatedSession('unconfirmed-wake')
        // CLI boots (writes running, stripping nothing hub-owned) but the
        // resume never confirms.
        const handlers = new Map<string, (payload: unknown, cb?: (result: unknown) => void) => void>()
        registerSessionHandlers({
            on: (event: string, handler: (payload: unknown, cb?: (result: unknown) => void) => void) => { handlers.set(event, handler) },
            to: () => ({ emit: () => {} }),
        } as never, {
            store,
            resolveSessionAccess: (sid: string) => {
                const stored = store.sessions.getSessionByNamespace(sid, NAMESPACE)
                return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
            },
            emitAccessError: () => {},
        } as never)
        spawnImpl = async (sessionId) => {
            const stored = store.sessions.getSession(sessionId)!
            const cliMetadata: Record<string, unknown> = { ...(stored.metadata as Record<string, unknown>), lifecycleState: 'running', lifecycleStateSince: Date.now() }
            delete cliMetadata.hibernation
            let ack: unknown
            handlers.get('update-metadata')!({ sid: sessionId, expectedVersion: stored.metadataVersion, metadata: cliMetadata }, (r) => { ack = r })
            expect((ack as { result: string }).result).toBe('success')
            cache().refreshSession(sessionId)
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'error', message: 'startup handshake failed' }
        }
        const result = await engine.resumeSession(id, NAMESPACE)
        expect(result.type).toBe('error')
        const woken = cache().getSession(id)!
        expect(woken.active).toBe(true)
        expect(woken.metadata?.lifecycleState).toBe('running')
        expect(woken.metadata?.hibernation?.state).toBe('hibernated')

        // Dedup keeps skipping the row while the wake is unconfirmed.
        const sources: string[] = []
        const merge = cache().mergeSessions.bind(cache())
        cache().mergeSessions = async (oldId: string, newId: string, namespace: string) => {
            sources.push(oldId)
            mergeCalls += 1
            return await merge(oldId, newId, namespace)
        }
        const dup = cache().getOrCreateSession('unconfirmed-dup', {
            path: '/tmp/project', host: 'localhost', flavor: 'claude', machineId: MACHINE,
            claudeSessionId: woken.metadata?.claudeSessionId,
        }, null, NAMESPACE).id
        await cache().deduplicateByAgentSessionId(dup)
        await cache().deduplicateByAgentSessionId(id)
        expect(sources).not.toContain(id)
        expect(store.sessions.getSession(id)).not.toBeNull()

        engine.handleSessionEnd({ sid: id, time: Date.now() })
        const after = cache().getSession(id)!
        expect(after.active).toBe(false)
        expect(after.metadata?.lifecycleState).toBe('hibernated')
        expect(after.metadata?.hibernation?.state).toBe('hibernated')
    })

    it('fails closed when the stray child cannot be confirmed stopped', async () => {
        const id = await hibernatedSession('stray-alive')
        spawnImpl = async () => ({ type: 'success', sessionId: 'stray-live' })
        gateway().stopRunnerSession = async (_machineId: string, sessionId: string) => {
            stopCalls.push(sessionId)
            return 'still_alive'
        }
        const result = await engine.resumeSession(id, NAMESPACE)
        expect(result).toMatchObject({ type: 'error', code: 'resume_failed', rollbackSafe: false })
        expect(stopCalls).toEqual([])
        expect(mergeCalls).toBe(0)

        store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'due' } }, 'local-due', Date.now() + 1_000)
        let spawns = 0
        spawnImpl = async (sessionId) => { spawns += 1; bootCli(sessionId); return { type: 'success', sessionId } }
        const wake = (engine as unknown as { wakeHibernatedForMatureScheduled: (now: number) => void })
            .wakeHibernatedForMatureScheduled.bind(engine)
        wake(Date.now() + 5_000)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(spawns).toBe(0)
    })

    it('backs off automatic wakes after a failed resume', async () => {
        const id = await hibernatedSession('wake-backoff')
        store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'due' } }, 'local-due', Date.now() + 1_000)
        let spawns = 0
        spawnImpl = async () => { spawns += 1; return { type: 'error', message: 'spawn failed' } }
        const wake = (engine as unknown as { wakeHibernatedForMatureScheduled: (now: number) => void })
            .wakeHibernatedForMatureScheduled.bind(engine)
        const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
        const base = Date.now() + 5_000

        wake(base)
        await settle()
        expect(spawns).toBe(1)
        for (let k = 1; k <= 5; k += 1) {
            wake(base + k * 5_000)
            await settle()
        }
        expect(spawns).toBe(1)
        wake(base + 10 * 60_000)
        await settle()
        expect(spawns).toBe(2)
    })

    it('INVARIANT resume of a hibernated session returns the same id or an error and never merges', async () => {
        const outcomes = ['same', 'different', 'error', 'never-active'] as const
        await forAll('resume-keeps-id', async (rand, i) => {
            const id = await hibernatedSession(`pbt-${i}`)
            const outcome = pick(rand, outcomes)
            spawnImpl = async (sessionId) => {
                if (outcome === 'error') return { type: 'error', message: 'spawn failed' }
                if (outcome === 'never-active') return { type: 'success', sessionId }
                if (outcome === 'different') return { type: 'success', sessionId: `stray-${i}` }
                bootCli(sessionId)
                return { type: 'success', sessionId }
            }
            const result = await engine.resumeSession(id, NAMESPACE)
            if (result.type === 'success') {
                expect(result.sessionId).toBe(id)
            } else {
                expect(result.type).toBe('error')
            }
            expect(outcome === 'same' ? result.type === 'success' : result.type === 'error').toBe(true)
            expect(mergeCalls).toBe(0)
            expect(cache().getSession(id)).toBeDefined()
        })
    })

    it.each(['ready', 'ended'] as const)('joins a Pi wake before sending while transport is active (%s)', async readiness => {
        const id = await hibernatedSession('join-wake', 'pi')
        let finish!: (status: typeof readiness) => void
        const waiting = new Promise<void>(resolve => {
            engine.waitForSessionReady = () => {
                resolve()
                return new Promise(done => { finish = done })
            }
        })
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', NAMESPACE); await next() })
        app.route('/api', createMessagesRoutes(() => engine))
        const post = (text: string) => app.request(`/api/sessions/${id}/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, localId: text })
        })
        const first = post('first')
        await waiting
        expect(cache().getSession(id)?.active).toBe(true)
        const second = post('second')
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(store.messages.getFirstMessages(id, 10)).toHaveLength(0)
        finish(readiness)
        const responses = await Promise.all([first, second])
        expect(responses.map(response => response.status)).toEqual(readiness === 'ready' ? [200, 200] : [500, 500])
        if (readiness === 'ended') {
            for (const response of responses) expect(await response.json()).toMatchObject({ code: 'resume_failed' })
        }
        expect(store.messages.getFirstMessages(id, 10).map(message => message.localId).sort())
            .toEqual(readiness === 'ready' ? ['first', 'second'] : [])
    })

    it('wakes a hibernated session when its scheduled message matures', async () => {
        const id = await hibernatedSession('scheduled')
        store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'wake up' } }, 'local-scheduled', Date.now() + 60_000)
        const resumed: string[] = []
        const original = engine.resumeSession.bind(engine)
        engine.resumeSession = async (sessionId, namespace, opts) => {
            resumed.push(sessionId)
            return await original(sessionId, namespace, opts)
        }
        const tick = (engine as unknown as { expireInactive: () => void }).expireInactive.bind(engine)
        const wake = (engine as unknown as { wakeHibernatedForMatureScheduled: (now: number) => void })
            .wakeHibernatedForMatureScheduled.bind(engine)

        tick()
        expect(resumed).toEqual([])

        wake(Date.now() + 120_000)
        expect(resumed).toEqual([id])
        await new Promise((resolve) => setTimeout(resolve, 0))
        for (let i = 0; i < 20 && !cache().getSession(id)!.active; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(cache().getSession(id)!.active).toBe(true)
    })
})

describe('POST /api/sessions/:id/messages on hibernated sessions', () => {
    function createApp(session: Partial<Session>, resumeResult: { type: 'success'; sessionId: string } | { type: 'error'; message: string; code: string } = { type: 'success', sessionId: 'session-1' }) {
        const calls: string[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: 'session-1', session: { id: 'session-1', ...session } }),
            resumeSession: async (sessionId: string, namespace: string) => {
                calls.push(`resume:${sessionId}:${namespace}`)
                return resumeResult
            },
            sendMessage: async (sessionId: string) => {
                calls.push(`send:${sessionId}`)
            },
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))
        const post = (body: Record<string, unknown>) => app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        return { post, calls }
    }

    const hibernated = { active: false, metadata: { path: '/tmp', host: 'h', lifecycleState: 'hibernated' } } as Partial<Session>

    it('auto-resumes before delivering', async () => {
        const { post, calls } = createApp(hibernated)
        const response = await post({ text: 'hello' })
        expect(response.status).toBe(200)
        expect(calls).toEqual(['resume:session-1:default', 'send:session-1'])
    })

    it('waits for an in-flight hibernation stop, then takes the auto-resume branch', async () => {
        let stopping = true
        const calls: string[] = []
        const engine = {
            resolveSessionAccess: () => ({
                ok: true,
                sessionId: 'session-1',
                session: stopping
                    ? { id: 'session-1', active: true, metadata: { path: '/tmp', host: 'h', lifecycleState: 'running' } }
                    : { id: 'session-1', ...hibernated },
            }),
            awaitHibernation: async () => {
                calls.push('await')
                stopping = false
                return true
            },
            resumeSession: async (sessionId: string) => {
                calls.push(`resume:${sessionId}`)
                return { type: 'success', sessionId }
            },
            sendMessage: async (sessionId: string) => { calls.push(`send:${sessionId}`) },
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'hello' }),
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual(['await', 'resume:session-1', 'send:session-1'])
    })

    it('validates the body before waiting on a hibernation stop', async () => {
        const calls: string[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: 'session-1', session: { id: 'session-1', active: true } }),
            awaitHibernation: async () => { calls.push('await'); return false },
            resumeSession: async () => { calls.push('resume'); return { type: 'success', sessionId: 'session-1' } },
            sendMessage: async () => { calls.push('send') },
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nope: true }),
        })
        expect(response.status).toBe(400)
        expect(calls).toEqual([])
    })

    it.each(['stopping', 'hibernated'] as const)('retries a send when the racing stop is %s at catch time', async (atCatch) => {
        let state: 'active' | 'stopping' | 'hibernated' = 'active'
        const calls: string[] = []
        const engine = {
            resolveSessionAccess: () => ({
                ok: true,
                sessionId: 'session-1',
                session: state === 'hibernated'
                    ? { id: 'session-1', ...hibernated }
                    : { id: 'session-1', active: true, metadata: { path: '/tmp', host: 'h', lifecycleState: 'running' } },
            }),
            awaitHibernation: async () => {
                if (state !== 'stopping') return false
                calls.push('await')
                state = 'hibernated'
                return true
            },
            hibernationInFlight: () => state === 'stopping',
            resumeSession: async (sessionId: string) => {
                calls.push(`resume:${sessionId}`)
                state = 'active'
                return { type: 'success', sessionId }
            },
            sendMessage: async (sessionId: string) => {
                calls.push(`send:${sessionId}`)
                if (calls.length === 1) {
                    // The sweep took the history lock between the read and the send.
                    state = atCatch
                    throw new Error(HISTORY_ACTION_IN_PROGRESS_MESSAGE)
                }
            },
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'hello' }),
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual(['send:session-1', ...(atCatch === 'stopping' ? ['await'] : []), 'resume:session-1', 'send:session-1'])
    })

    it('does not retry a history-busy error that is not a hibernation', async () => {
        let sends = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: 'session-1', session: { id: 'session-1', active: true } }),
            awaitHibernation: async () => false,
            hibernationInFlight: () => false,
            resumeSession: async () => ({ type: 'success', sessionId: 'session-1' }),
            sendMessage: async () => { sends += 1; throw new Error(HISTORY_ACTION_IN_PROGRESS_MESSAGE) },
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => engine))
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'hello' }),
        })
        expect(response.status).toBe(500)
        expect(sends).toBe(1)
    })

    it('surfaces a failed wake and does not deliver', async () => {
        const { post, calls } = createApp(hibernated, { type: 'error', message: 'No machine online', code: 'no_machine_online' })
        const response = await post({ text: 'hello' })
        expect(response.status).toBe(503)
        expect(calls).toEqual(['resume:session-1:default'])
    })

    it('leaves a future scheduled send for the due-time wake', async () => {
        const { post, calls } = createApp(hibernated)
        const response = await post({ text: 'later', localId: 'local-1', scheduledAt: Date.now() + HOUR })
        expect(response.status).toBe(200)
        expect(calls).toEqual(['send:session-1'])
    })

    it('keeps the inactive 409 for sessions that are not hibernated', async () => {
        const { post, calls } = createApp({ active: false, metadata: { path: '/tmp', host: 'h', lifecycleState: 'archived' } } as Partial<Session>)
        const response = await post({ text: 'hello' })
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Session is inactive', code: 'session_inactive' })
        expect(calls).toEqual([])
    })
})
