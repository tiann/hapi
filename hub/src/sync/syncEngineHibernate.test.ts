import { registerTerminalHandlers } from '../socket/handlers/terminal'
import { TerminalRegistry } from '../socket/terminalRegistry'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError, RunnerStopRpcError } from './rpcGateway'
import type { SessionCache } from './sessionCache'

const HOUR = 60 * 60 * 1000
const WINDOW = 2 * HOUR
const NAMESPACE = 'default'
const MACHINE = 'machine-1'

type StopStatus = 'stopped' | 'already_gone' | 'still_alive' | 'unknown'

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

describe('SyncEngine hibernation', () => {
    let store: Store
    let engine: SyncEngine
    let stopCalls: Array<{ machineId: string; sessionId: string }>
    let killCalls: string[]
    let stopImpl: (machineId: string, sessionId: string) => Promise<StopStatus>

    function cache(): SessionCache {
        return (engine as unknown as { sessionCache: SessionCache }).sessionCache
    }

    function gateway(): Record<string, unknown> {
        return (engine as unknown as { rpcGateway: Record<string, unknown> }).rpcGateway
    }

    function registerMachine(capabilities: Record<string, unknown> = { sessionHibernation: true }, machineId = MACHINE): void {
        engine.getOrCreateMachine(machineId, { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            { status: 'running', capabilities }, NAMESPACE)
        engine.handleMachineAlive({ machineId, time: Date.now() })
    }

    function insertIdleSession(tag: string, metadata: Record<string, unknown> = {}): string {
        const created = cache().getOrCreateSession(tag, {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'claude',
            startedBy: 'runner',
            startedFromRunner: true,
            machineId: MACHINE,
            claudeSessionId: `native-${tag}`,
            lifecycleState: 'running',
            ...metadata,
        }, null, NAMESPACE)
        engine.handleSessionAlive({ sid: created.id, time: Date.now() })
        return created.id
    }

    function later(): number {
        return Date.now() + 3 * HOUR
    }

    function endingStop(status: StopStatus): (machineId: string, sessionId: string) => Promise<StopStatus> {
        return async (_machineId, sessionId) => {
            if (status === 'stopped' || status === 'already_gone') {
                engine.handleSessionEnd({ sid: sessionId, time: Date.now() })
            }
            return status
        }
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        stopCalls = []
        killCalls = []
        stopImpl = endingStop('stopped')
        engine.waitForSessionInactive = async id => cache().getSession(id)?.active === false
        gateway().stopRunnerSession = async (machineId: string, sessionId: string) => {
            stopCalls.push({ machineId, sessionId })
            return await stopImpl(machineId, sessionId)
        }
        gateway().killSession = async (sessionId: string) => {
            killCalls.push(sessionId)
            throw new RpcTargetMissingError('KillSession', 'handler-not-registered')
        }
        registerMachine()
    })

    afterEach(() => {
        engine.stop()
    })

    it('stops an idle runner session and marks it hibernated without reordering the list', async () => {
        const id = insertIdleSession('idle-1')
        const updatedAtBefore = cache().getSession(id)!.updatedAt

        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])

        const session = cache().getSession(id)!
        expect(session.active).toBe(false)
        expect(session.metadata?.lifecycleState).toBe('hibernated')
        expect(session.metadata?.hibernation?.state).toBe('hibernated')
        expect(session.metadata?.hibernation?.reason).toBe('idle')
        expect(session.updatedAt).toBe(updatedAtBefore)
        expect(stopCalls).toEqual([{ machineId: MACHINE, sessionId: id }])
        // Direct StopSession: KillSession would let the wrapper exit first and
        // orphan its children.
        expect(killCalls).toEqual([])
    })

    it('hibernates only the single-session Codex root on a shared-runtime-capable runner', async () => {
        const machineId = 'shared-capable'
        registerMachine({ sessionHibernation: true, codexSharedRuntime: true }, machineId)
        const shared = insertIdleSession('shared', { machineId, flavor: 'codex', codexSessionId: 'shared-thread',
            capabilities: { concurrentClients: true } })
        const single = insertIdleSession('single', { machineId, flavor: 'codex', codexSessionId: 'single-thread' })
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([single])
        expect(cache().getSession(shared)?.active).toBe(true)
        expect(stopCalls).toEqual([{ machineId, sessionId: single }])
        expect(killCalls).toEqual([])
    })

    it('writes the stopping marker before the stop RPC and drops CLI archive fields afterwards', async () => {
        const id = insertIdleSession('idle-cli-archive')
        let markerDuringStop: unknown
        stopImpl = async (_machineId, sessionId) => {
            markerDuringStop = store.sessions.getSession(sessionId)?.metadata
            const stored = store.sessions.getSession(sessionId)!
            store.sessions.updateSessionMetadata(sessionId, {
                ...(stored.metadata as object), lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'SIGTERM'
            }, stored.metadataVersion, NAMESPACE)
            cache().refreshSession(sessionId)
            engine.handleSessionEnd({ sid: sessionId, time: Date.now() })
            return 'stopped'
        }

        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])

        expect((markerDuringStop as Session['metadata'])?.hibernation?.state).toBe('stopping')
        const metadata = cache().getSession(id)!.metadata!
        expect(metadata.lifecycleState).toBe('hibernated')
        expect(metadata.archivedBy).toBeUndefined()
        expect(metadata.archiveReason).toBeUndefined()
    })

    it('skips the dedup merge on the hibernation session-end', async () => {
        const id = insertIdleSession('idle-dedup')
        let dedupCalls = 0
        const original = cache().deduplicateByAgentSessionId.bind(cache())
        cache().deduplicateByAgentSessionId = async (sessionId: string) => {
            dedupCalls += 1
            return await original(sessionId)
        }
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])
        expect(dedupCalls).toBe(0)
    })

    it('never dedup-merges a hibernated row into a live duplicate', async () => {
        const id = insertIdleSession('dedup-hibernated', { claudeSessionId: 'native-shared' })
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])
        const sources: string[] = []
        const merge = cache().mergeSessions.bind(cache())
        cache().mergeSessions = async (oldId: string, newId: string, namespace: string) => {
            sources.push(oldId)
            return await merge(oldId, newId, namespace)
        }
        const mergeHistory = (cache() as unknown as { mergeSessionHistory: (...args: unknown[]) => Promise<unknown> }).mergeSessionHistory.bind(cache())
        ;(cache() as unknown as { mergeSessionHistory: unknown }).mergeSessionHistory = async (...args: unknown[]) => {
            sources.push(args[0] as string)
            return await mergeHistory(...args)
        }

        const live = insertIdleSession('dedup-live', { claudeSessionId: 'native-shared' })
        await cache().deduplicateByAgentSessionId(live)
        await cache().deduplicateByAgentSessionId(id)

        expect(sources).not.toContain(id)
        expect(store.sessions.getSession(id)).not.toBeNull()
        expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('hibernated')
    })

    it('uses the immediate and scheduled partial indexes to count pending prompts', () => {
        const db = (store as unknown as { db: Database }).db
        const prepare = spyOn(db, 'prepare')
        let queries: string[]
        try {
            store.messages.countUndeliveredForSession('check-indexes')
            queries = prepare.mock.calls.map(([sql]) => sql)
        } finally {
            prepare.mockRestore()
        }
        const plans = queries.flatMap(sql => db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`)
            .all('check-indexes').map(row => row.detail))
        expect(plans.some(plan => plan.includes('idx_messages_immediate_queued'))).toBe(true)
        expect(plans.some(plan => plan.includes('idx_messages_future_scheduled_queued'))).toBe(true)
    })

    it('skips store-backed signal collection for ineligible sessions', async () => {
        insertIdleSession('exempt', { idleReconcileExempt: true })
        insertIdleSession('pty', { startingMode: 'pty' })
        insertIdleSession('blocked-flavor', { flavor: 'cursor' })
        insertIdleSession('blocked-opencode', { flavor: 'opencode', opencodeForkPending: true })
        const lookup = spyOn(store.messages, 'countUndeliveredForSession')
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([])
        expect(lookup).not.toHaveBeenCalled()
    })

    it('reconciles transcript work before either idle check on the same tick', () => {
        const id = insertIdleSession('open-tool')
        store.messages.getLiveToolWork = () => true
        const seen: boolean[] = []
        cache().reconcileKeepaliveIdle = () => {
            seen.push(cache().getSession(id)?.derivedToolWork === true)
            return []
        }
        engine.hibernateIdleSessions = async () => {
            seen.push(cache().getSession(id)?.derivedToolWork === true)
            return []
        }
        ;(engine as unknown as { expireInactive(): void }).expireInactive()
        expect(seen).toEqual([true, true])
    })

    it('counts only queued user prompts as undelivered', async () => {
        const id = insertIdleSession('undelivered-scope')
        store.messages.addMessage(id, { role: 'agent', content: { type: 'event', data: { type: 'compaction', status: 'started' } } }, 'compaction:started')
        store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'stuck' } }, 'local-stuck')
        store.messages.setMessagesDeliveryState(id, ['local-stuck'], 'indeterminate')
        expect(store.messages.countUndeliveredForSession(id)).toBe(0)
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])

        const other = insertIdleSession('undelivered-queued')
        store.messages.addMessage(other, { role: 'user', content: { type: 'text', text: 'pending' } }, 'local-queued')
        store.messages.addMessage(other, { role: 'user', content: { type: 'text', text: 'later' } }, 'local-scheduled', Date.now() + 10 * HOUR)
        expect(store.messages.countUndeliveredForSession(other)).toBe(2)
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([])
    })

    it.each(['cli', undefined])('restores an unconfirmed CLI self-archive with archivedBy=%s', async (archivedBy) => {
        const id = insertIdleSession('abandon-cli-archive')
        stopImpl = async (_machineId, sessionId) => {
            const stored = store.sessions.getSession(sessionId)!
            store.sessions.updateSessionMetadata(sessionId, {
                ...(stored.metadata as object), lifecycleState: 'archived', archivedBy, archiveReason: 'SIGTERM'
            }, stored.metadataVersion, NAMESPACE)
            cache().refreshSession(sessionId)
            engine.handleSessionEnd({ sid: sessionId, time: Date.now() })
            return 'still_alive'
        }
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([])
        const session = cache().getSession(id)!
        expect(session.active).toBe(false)
        expect(session.metadata?.lifecycleState).toBe('running')
        expect(session.metadata?.archivedBy).toBeUndefined()
        expect(session.metadata?.archiveReason).toBeUndefined()
        expect(session.metadata?.hibernation?.state).toBe('stopping')
        stopImpl = async () => 'unknown'
        expect(await engine.hibernateIdleSessions(later() + 600_000, WINDOW)).toEqual([])
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
        expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('running')
    })

    it('ignores the idle reconciler stamp so the window is not stretched', async () => {
        const id = insertIdleSession('idle-stamp', { lifecycleState: 'idle', lifecycleStateSince: Date.now() + 2 * HOUR })
        expect(await engine.hibernateIdleSessions(Date.now() + 3 * HOUR, WINDOW)).toEqual([id])
    })

    it('rejects a terminal open while waiting for the hibernation stop RPC', async () => {
        const id = insertIdleSession('await-stop')
        expect(await engine.awaitHibernation(id)).toBe(false)
        let release!: () => void
        stopImpl = (_machineId, sessionId) => new Promise((resolve) => {
            release = () => {
                engine.handleSessionEnd({ sid: sessionId, time: Date.now() })
                resolve('stopped')
            }
        })
        const running = engine.hibernateSession(id, { now: later(), hibernateMs: WINDOW })
        for (let i = 0; i < 10 && !release; i += 1) await Promise.resolve()
        expect(cache().getSession(id)!.active).toBe(true)
        const registry = new TerminalRegistry({ idleTimeoutMs: 0 })
        const handlers = new Map<string, (data: unknown) => void>()
        const events: string[] = []
        registerTerminalHandlers({
            data: { namespace: NAMESPACE }, on: (event: string, fn: (data: unknown) => void) => handlers.set(event, fn),
            emit: (event: string) => events.push(event)
        } as never, {
            io: { of: () => ({}) } as never, terminalRegistry: registry, maxTerminalsPerSession: 4, maxTerminalsPerSocket: 4,
            getSession: sid => engine.getSession(sid) ?? null, hibernationInFlight: sid => engine.hibernationInFlight(sid)
        })
        handlers.get('terminal:create')!({ sessionId: id, terminalId: 'new-terminal', cols: 80, rows: 24 })
        expect(events).toEqual(['terminal:error'])
        expect(registry.countForSession(id)).toBe(0)
        const waited = engine.awaitHibernation(id)
        release()
        expect(await waited).toBe(true)
        expect(cache().getSession(id)!.metadata?.lifecycleState).toBe('hibernated')
        expect(await running).toBe('hibernated')
    })

    it('hibernates at most one session per machine per sweep', async () => {
        const a = insertIdleSession('idle-a')
        const b = insertIdleSession('idle-b')
        const first = await engine.hibernateIdleSessions(later(), WINDOW)
        expect(first).toHaveLength(1)
        const second = await engine.hibernateIdleSessions(later(), WINDOW)
        expect(second).toHaveLength(1)
        expect(new Set([...first, ...second])).toEqual(new Set([a, b]))
    })

    it.each(['already_gone', 'stopped', 'still_alive', 'unknown'] as const)(
        'rechecks cleanup after a delayed session-end and settles only with evidence (%s)', async outcome => {
            const id = insertIdleSession('cleanup-retry')
            const now = later()
            engine.waitForSessionInactive = SyncEngine.prototype.waitForSessionInactive
            stopImpl = async () => {
                setTimeout(() => engine.handleSessionEnd({ sid: id, time: Date.now() }), 0)
                return 'still_alive'
            }
            expect(await engine.hibernateIdleSessions(now, WINDOW)).toEqual([])
            expect(cache().getSession(id)?.active).toBe(false)
            expect(cache().getSession(id)?.metadata?.hibernation?.state).toBe('stopping')
            expect(await engine.hibernateIdleSessions(now + 599_999, WINDOW)).toEqual([])
            expect(stopCalls).toHaveLength(1)
            stopImpl = async () => outcome
            const confirmed = outcome === 'already_gone' || outcome === 'stopped'
            expect(await engine.hibernateIdleSessions(now + 600_000, WINDOW)).toEqual(confirmed ? [id] : [])
            expect(stopCalls).toHaveLength(2)
            expect(cache().getSession(id)?.metadata?.hibernation?.state).toBe(confirmed ? 'hibernated' : undefined)
            expect(cache().getSession(id)?.metadata?.lifecycleState).toBe(confirmed ? 'hibernated' : 'running')
            expect(await engine.hibernateIdleSessions(now + 1_200_000, WINDOW)).toEqual([])
            expect(stopCalls).toHaveLength(2)
        }
    )

    it('lets resume cancel the pending cleanup retry before the backoff expires', async () => {
        const id = insertIdleSession('resume-before-cleanup')
        const now = later()
        stopImpl = async () => {
            engine.handleSessionEnd({ sid: id, time: Date.now() })
            return 'unknown'
        }
        expect(await engine.hibernateIdleSessions(now, WINDOW)).toEqual([])
        expect(cache().getSession(id)?.metadata?.hibernation?.state).toBe('stopping')
        gateway().spawnSession = async () => {
            engine.handleSessionAlive({ sid: id, time: Date.now() })
            return { type: 'success', sessionId: id }
        }
        expect(await engine.resumeSession(id, NAMESPACE)).toEqual({ type: 'success', sessionId: id })
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
        engine.handleSessionEnd({ sid: id, time: Date.now() })
        expect(await engine.hibernateIdleSessions(now + 600_000, WINDOW)).toEqual([])
        expect(stopCalls).toHaveLength(1)
    })

    it('backs off 10 minutes after an unconfirmed stop and clears the marker', async () => {
        const id = insertIdleSession('idle-still-alive')
        stopImpl = endingStop('still_alive')
        const now = later()

        expect(await engine.hibernateIdleSessions(now, WINDOW)).toEqual([])
        const session = cache().getSession(id)!
        expect(session.active).toBe(true)
        expect(session.metadata?.lifecycleState).toBe('running')
        expect(session.metadata?.hibernation).toBeUndefined()
        expect(stopCalls).toHaveLength(1)

        expect(await engine.hibernateIdleSessions(now + 9 * 60_000, WINDOW)).toEqual([])
        expect(stopCalls).toHaveLength(1)

        stopImpl = endingStop('stopped')
        expect(await engine.hibernateIdleSessions(now + 10 * 60_000, WINDOW)).toEqual([id])
        expect(stopCalls).toHaveLength(2)
    })

    it('never hibernates without the runner capability, inside the window, or for ineligible flavors', async () => {
        insertIdleSession('idle-cursor', { flavor: 'cursor', cursorSessionId: 'c' })
        insertIdleSession('idle-agy', { flavor: 'agy', agySessionId: 'a' })
        insertIdleSession('idle-terminal', { startedBy: 'terminal', startedFromRunner: false })
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([])

        const fresh = insertIdleSession('idle-fresh')
        expect(await engine.hibernateIdleSessions(Date.now() + WINDOW / 2, WINDOW)).toEqual([])
        expect(cache().getSession(fresh)!.active).toBe(true)
        expect(stopCalls).toEqual([])

        registerMachine({ piExistingSessionResume: true }, 'machine-old')
        const legacy = insertIdleSession('idle-legacy-runner', { machineId: 'machine-old' })
        const swept = await engine.hibernateIdleSessions(later(), WINDOW)
        expect(swept).not.toContain(legacy)
        expect(stopCalls.some((call) => call.sessionId === legacy)).toBe(false)
        expect(cache().getSession(legacy)!.active).toBe(true)
    })

    it('treats engine-side signals as live work', async () => {
        const id = insertIdleSession('idle-signals')
        engine.setTerminalSessionCounter((sid) => sid === id ? 1 : 0)
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([])
        engine.setTerminalSessionCounter(null)

        store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'later' } }, 'local-1', Date.now() + 10 * HOUR)
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([])
        expect(stopCalls).toEqual([])
    })

    it('uses lifecycleStateSince as progress so a freshly resumed session waits a full window', async () => {
        const id = insertIdleSession('idle-since', { lifecycleStateSince: Date.now() + 2 * HOUR })
        expect(await engine.hibernateIdleSessions(Date.now() + 3 * HOUR, WINDOW)).toEqual([])
        expect(await engine.hibernateIdleSessions(Date.now() + 4 * HOUR + 1_000, WINDOW)).toEqual([id])
    })

    it('INVARIANT disabled switch issues zero stop RPCs', async () => {
        insertIdleSession('idle-disabled')
        await forAll('disabled-zero-rpc', async (rand) => {
            const hibernateMs = rand() < 0.5 ? 0 : -Math.floor(rand() * 1e9)
            const now = Date.now() + Math.floor(rand() * 1000 * HOUR)
            expect(await engine.hibernateIdleSessions(now, hibernateMs)).toEqual([])
        })
        expect(stopCalls).toEqual([])
        expect(killCalls).toEqual([])
    })

    it('INVARIANT hibernated iff the stop result is stopped or already_gone', async () => {
        const outcomes = ['stopped', 'already_gone', 'still_alive', 'unknown', 'throw', 'timeout'] as const
        await forAll('stop-confirmation', async (rand, i) => {
            const outcome = pick(rand, outcomes)
            const id = insertIdleSession(`confirm-${i}`)
            stopImpl = async (_machineId, sessionId) => {
                if (outcome === 'throw') throw new RpcTargetMissingError('StopSession', 'socket-disconnected')
                if (outcome === 'timeout') throw new RunnerStopRpcError(true, new Error('ack timeout'))
                return await endingStop(outcome)(_machineId, sessionId)
            }
            const result = await engine.hibernateSession(id, { now: later(), hibernateMs: WINDOW })
            const session = cache().getSession(id)!
            const confirmed = outcome === 'stopped' || outcome === 'already_gone'
            expect(result).toBe(confirmed ? 'hibernated' : 'failed')
            expect(session.metadata?.lifecycleState === 'hibernated').toBe(confirmed)
            if (confirmed) {
                expect(session.active).toBe(false)
                expect(session.metadata?.hibernation?.state).toBe('hibernated')
            } else {
                expect(session.active).toBe(true)
                expect(session.metadata?.lifecycleState).toBe('running')
                expect(session.metadata?.hibernation).toBeUndefined()
            }
        })
    })

    it('INVARIANT hibernate / resume / archive are mutually exclusive per session', async () => {
        let pending = 0
        let maxPending = 0
        const yieldRandomly = async (rand: () => number) => {
            const hops = Math.floor(rand() * 4)
            for (let i = 0; i < hops; i += 1) await Promise.resolve()
        }
        let rand: () => number = Math.random
        const enter = () => { pending += 1; maxPending = Math.max(maxPending, pending) }
        const leave = () => { pending -= 1 }
        stopImpl = async (_machineId, sessionId) => {
            enter()
            try {
                await yieldRandomly(rand)
                if (cache().getSession(sessionId)?.active) engine.handleSessionEnd({ sid: sessionId, time: Date.now() })
                return 'stopped'
            } finally { leave() }
        }
        gateway().killSession = async (sessionId: string) => {
            enter()
            try {
                await yieldRandomly(rand)
                if (!cache().getSession(sessionId)?.active) throw new RpcTargetMissingError('KillSession', 'socket-disconnected')
                return {}
            } finally { leave() }
        }
        gateway().spawnSession = async (...args: unknown[]) => {
            enter()
            try {
                await yieldRandomly(rand)
                const sid = args[12] as string
                const stored = store.sessions.getSession(sid)!
                store.sessions.updateSessionMetadata(sid, { ...(stored.metadata as object), lifecycleState: 'running', lifecycleStateSince: Date.now() },
                    stored.metadataVersion, NAMESPACE, { touchUpdatedAt: false, allowUnarchive: true })
                cache().refreshSession(sid)
                engine.handleSessionAlive({ sid, time: Date.now() })
                return { type: 'success', sessionId: sid }
            } finally { leave() }
        }
        const ops = ['hibernate', 'resume', 'archive'] as const
        await forAll('mutual-exclusion', async (r, i) => {
            rand = r
            pending = 0
            maxPending = 0
            const id = insertIdleSession(`mutex-${i}`)
            const count = 2 + Math.floor(r() * 4)
            const runs: Array<Promise<unknown>> = []
            for (let k = 0; k < count; k += 1) {
                const op = pick(r, ops)
                const launch = async () => {
                    await yieldRandomly(r)
                    if (op === 'hibernate') return await engine.hibernateSession(id, { now: later(), hibernateMs: WINDOW })
                    if (op === 'resume') return await engine.resumeSession(id, NAMESPACE)
                    return await engine.archiveSession(id)
                }
                runs.push(launch())
            }
            await Promise.allSettled(runs)
            expect(maxPending).toBeLessThanOrEqual(1)
            const session = cache().getSession(id)!
            const lifecycle = session.metadata?.lifecycleState
            const terminal = (session.active && lifecycle === 'running')
                || (!session.active && lifecycle === 'hibernated')
                || lifecycle === 'archived'
            expect(terminal).toBe(true)
        })
    })

    it('drops a leftover stopping marker on hub start without settling it to hibernated', () => {
        const plainId = insertIdleSession('restart-plain')
        const cliArchivedId = insertIdleSession('restart-cli-archived')
        const activeId = insertIdleSession('restart-active')
        for (const sid of [plainId, cliArchivedId, activeId]) {
            const stored = store.sessions.getSession(sid)!
            store.sessions.updateSessionMetadata(sid, {
                ...(stored.metadata as object),
                hibernation: { state: 'stopping', since: Date.now(), reason: 'idle' },
                ...(sid === cliArchivedId ? { lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'SIGTERM' } : {}),
            }, stored.metadataVersion, NAMESPACE)
        }
        store.sessions.setSessionActive(plainId, false, Date.now(), NAMESPACE)
        store.sessions.setSessionActive(cliArchivedId, false, Date.now(), NAMESPACE)
        engine.stop()

        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        expect(cache().getSession(cliArchivedId)?.metadata?.lifecycleState).toBe('archived')
        expect(cache().getSession(cliArchivedId)?.metadata?.hibernation).toBeUndefined()
        for (const sid of [plainId, activeId]) {
            const metadata = cache().getSession(sid)!.metadata!
            expect(metadata.hibernation).toBeUndefined()
            expect(metadata.lifecycleState).toBe('running')
            expect(metadata.archivedBy).toBeUndefined()
            expect(metadata.archiveReason).toBeUndefined()
        }
    })

    it.each(['cli', 'hub', undefined])('preserves archived rows with stale settled markers at startup (%s)', archivedBy => {
        const id = insertIdleSession('archived-on-restart', { lifecycleState: 'archived', archivedBy,
            hibernation: { state: 'hibernated', since: 10, reason: 'idle' } })
        store.sessions.setSessionActive(id, false, Date.now(), NAMESPACE)
        engine.stop()
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('archived')
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
    })

    it.each(['offline', 'unknown', 'timeout'] as const)('archives a confirmed hibernation when runner confirmation is %s', async outcome => {
        const id = insertIdleSession('archive-offline')
        expect(await engine.hibernateSession(id, { now: later(), hibernateMs: WINDOW })).toBe('hibernated')
        stopCalls.length = 0
        stopImpl = async () => {
            if (outcome === 'unknown') return 'unknown'
            throw new Error(outcome)
        }
        await engine.archiveSession(id)
        expect(stopCalls).toEqual([{ machineId: MACHINE, sessionId: id }])
        expect(killCalls).toEqual([])
        expect(cache().getSession(id)?.metadata).toMatchObject({ lifecycleState: 'archived', archivedBy: 'hub' })
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
    })

    it('refuses to archive if the runner reports a hibernated session still alive', async () => {
        const id = insertIdleSession('archive-still-alive')
        expect(await engine.hibernateSession(id, { now: later(), hibernateMs: WINDOW })).toBe('hibernated')
        stopImpl = async () => 'still_alive'
        await expect(engine.archiveSession(id)).rejects.toThrow()
        expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('hibernated')
    })

    it('clears hibernation when the CLI archives first during an explicit archive', async () => {
        const id = insertIdleSession('archive-first')
        expect(await engine.hibernateSession(id, { now: later(), hibernateMs: WINDOW })).toBe('hibernated')
        const row = store.sessions.getSession(id)!
        store.sessions.updateSessionMetadata(id, { ...(row.metadata as object), lifecycleState: 'archived' },
            row.metadataVersion, NAMESPACE)
        cache().refreshSession(id)
        await engine.archiveSession(id)
        expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('archived')
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
    })

    it('abandons the stop and backs off when post-RPC confirmation throws', async () => {
        const id = insertIdleSession('failed-confirmation')
        const now = later()
        stopImpl = async () => 'stopped'
        const internal = engine as unknown as { waitForSessionInactive(id: string): Promise<boolean> }
        internal.waitForSessionInactive = async () => { throw new Error('confirmation unavailable') }
        expect(await engine.hibernateSession(id, { now, hibernateMs: WINDOW })).toBe('failed')
        expect(cache().getSession(id)?.metadata?.hibernation).toBeUndefined()
        expect(await engine.hibernateIdleSessions(now + 599_999, WINDOW)).toEqual([])
        expect(stopCalls).toHaveLength(1)
    })

    it.each(['archiveSession', 'resumeSession', 'reopenSession'] as const)('%s proceeds after a rejected stop', async method => {
        const id = insertIdleSession('reject-stop')
        const tails = (engine as unknown as { hibernateTails: Map<string, Promise<unknown>> }).hibernateTails
        tails.set(id, Promise.reject(new Error('stop failed')))
        const result = await engine[method](id, NAMESPACE)
        if (method === 'archiveSession') expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('archived')
        else expect(result).toMatchObject({ type: 'success', sessionId: id })
    })

    it('returns a woken-but-unconfirmed row to hibernated on hub start', () => {
        const id = insertIdleSession('restart-woken')
        const stored = store.sessions.getSession(id)!
        store.sessions.updateSessionMetadata(id, {
            ...(stored.metadata as object), hibernation: { state: 'hibernated', since: 1_000, reason: 'idle' }
        }, stored.metadataVersion, NAMESPACE)
        store.sessions.setSessionActive(id, false, Date.now(), NAMESPACE)
        engine.stop()

        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        expect(cache().getSession(id)!.metadata?.lifecycleState).toBe('hibernated')
        expect(cache().getSession(id)!.metadata?.hibernation?.state).toBe('hibernated')
    })

    it('a throwing signal source does not reject the sweep or the tick', async () => {
        const id = insertIdleSession('throwing-signal')
        engine.setTerminalSessionCounter(() => { throw new Error('terminal registry exploded') })
        await expect(engine.hibernateIdleSessions(later(), WINDOW)).resolves.toEqual([])
        expect(stopCalls).toEqual([])
        const tick = (engine as unknown as { expireInactive: () => void }).expireInactive.bind(engine)
        ;(engine as unknown as { io: unknown }).io = { of: () => ({ to: () => ({ emit() {} }) }) }
        expect(() => tick()).not.toThrow()
        await new Promise((resolve) => setTimeout(resolve, 0))
        engine.setTerminalSessionCounter(null)
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])
    })

    it('passes requireProcessGroupCleanup on the hibernation stop only', async () => {
        const id = insertIdleSession('pgroup-cleanup')
        const options: unknown[] = []
        gateway().stopRunnerSession = async (_machineId: string, sessionId: string, opts?: unknown) => {
            options.push(opts)
            engine.handleSessionEnd({ sid: sessionId, time: Date.now() })
            return 'stopped'
        }
        expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])
        expect(options).toHaveLength(1)
        expect((options[0] as { requireProcessGroupCleanup?: boolean }).requireProcessGroupCleanup).toBe(true)

        options.length = 0
        const archiveId = insertIdleSession('pgroup-archive')
        await engine.archiveSession(archiveId)
        expect(options.length).toBeGreaterThan(0)
        for (const opts of options) {
            expect((opts as { requireProcessGroupCleanup?: boolean } | undefined)?.requireProcessGroupCleanup).toBeUndefined()
        }
    })

    describe('cold-cache startup grace', () => {
        it('waits for hub uptime >= HIBERNATE_STARTUP_GRACE_MS', async () => {
            expect(SyncEngine.HIBERNATE_STARTUP_GRACE_MS).toBe(600_000)
            const id = insertIdleSession('grace-uptime')
            const shortWindow = 60_000
            expect(await engine.hibernateIdleSessions(Date.now() + 5 * 60_000, shortWindow)).toEqual([])
            expect(await engine.hibernateSession(id, { now: Date.now() + 5 * 60_000, hibernateMs: shortWindow })).toBe('skipped')
            expect(stopCalls).toEqual([])
            expect(await engine.hibernateIdleSessions(Date.now() + 11 * 60_000, shortWindow)).toEqual([id])
        })

        it('requires a session-alive since hub start', async () => {
            const id = insertIdleSession('grace-alive')
            engine.stop()
            engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            gateway().stopRunnerSession = async (machineId: string, sessionId: string) => {
                stopCalls.push({ machineId, sessionId })
                return await stopImpl(machineId, sessionId)
            }
            registerMachine()
            cache().markSessionActive(id)
            expect(cache().getSession(id)!.active).toBe(true)
            expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([])
            expect(stopCalls).toEqual([])

            engine.handleSessionAlive({ sid: id, time: Date.now() })
            expect(await engine.hibernateIdleSessions(later(), WINDOW)).toEqual([id])
        })
    })
})
