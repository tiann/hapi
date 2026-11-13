import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { AttachedJobUpsert } from '@hapi/protocol'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

function stubEngine(store: Store): SyncEngine {
    // Minimal construction: SyncEngine needs many deps; use the same pattern
    // as other store-heavy tests by casting a partial.
    // Object.create skips field initializers — seed wake-retry state explicitly.
    const engine = Object.create(SyncEngine.prototype) as SyncEngine
    ;(engine as unknown as { store: Store }).store = store
    ;(engine as unknown as { jobTerminalWakeRetryTimers: Map<string, ReturnType<typeof setTimeout>> })
        .jobTerminalWakeRetryTimers = new Map()
    ;(engine as unknown as { jobTerminalWakeRetryAttempts: Map<string, number> })
        .jobTerminalWakeRetryAttempts = new Map()
    ;(engine as unknown as { jobWakeRetryBaseMs: number }).jobWakeRetryBaseMs = 1_000
    const sessions = new Map<string, { id: string; namespace: string; active: boolean; metadata?: { flavor?: string; piSessionId?: string } }>()
    ;(engine as unknown as {
        sessionCache: {
            emitAttachedJobChanged: () => void
            getSession: (id: string) => { id: string; namespace: string; active: boolean; metadata?: { flavor?: string; piSessionId?: string } } | null
            getPrimaryRunning?: () => null
        }
    }).sessionCache = {
        emitAttachedJobChanged: () => undefined,
        getSession: (id) => sessions.get(id) ?? null,
    }
    ;(engine as unknown as { _sessions: typeof sessions })._sessions = sessions
    // Identity redirects unless a test overrides (ownership-transfer coverage).
    ;(engine as unknown as { resolveAttachedJobSessionId: (id: string) => string })
        .resolveAttachedJobSessionId = (id) => id
    ;(engine as unknown as {
        resolveAttachedJobKey: (_a: string, _b: string, key: string) => string
    }).resolveAttachedJobKey = (_a, _b, key) => key
    return engine
}

describe('SyncEngine job terminal wake scheduling (#1489)', () => {
    afterEach(() => {
        mock.restore()
    })

    it('schedules resume+send once on terminal patch with wakeOnTerminal', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-test', { path: '/tmp', flavor: 'cursor' }, null, 'default')

        const engine = stubEngine(store)
        const sessions = (engine as unknown as { _sessions: Map<string, { id: string; namespace: string; active: boolean }> })._sessions
        sessions.set(session.id, { id: session.id, namespace: 'default', active: false })

        const resumeCalls: string[] = []
        const sendCalls: Array<{ sessionId: string; text: string }> = []

        ;(engine as unknown as {
            resumeSession: (id: string, ns: string) => Promise<{ type: 'success'; sessionId: string }>
        }).resumeSession = async (id) => {
            resumeCalls.push(id)
            sessions.set(id, { id, namespace: 'default', active: true })
            return { type: 'success', sessionId: id }
        }
        ;(engine as unknown as {
            sendMessage: (id: string, payload: { text: string }) => Promise<void>
        }).sendMessage = async (id, payload) => {
            sendCalls.push({ sessionId: id, text: payload.text })
        }

        const body: AttachedJobUpsert = {
            label: 'batch',
            status: 'running',
            runId: 'run-wake-1',
            wakeOnTerminal: true,
            wakePrompt: 'Continue.',
            detail: 'chunk 1',
        }
        const upserted = engine.upsertSessionJob(session.id, 'batch', body)
        expect(upserted.outcome).toBe('upserted')
        await Promise.resolve()
        expect(resumeCalls).toEqual([])
        expect(sendCalls).toEqual([])

        const patched = engine.patchSessionJob(session.id, 'batch', {
            status: 'completed',
            expectedRunId: 'run-wake-1',
            detail: 'chunk 1 done',
        })
        expect(patched.outcome).toBe('patched')

        for (let i = 0; i < 20 && sendCalls.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 10))
        }

        expect(resumeCalls).toEqual([session.id])
        expect(sendCalls).toHaveLength(1)
        expect(sendCalls[0]!.sessionId).toBe(session.id)
        expect(sendCalls[0]!.text).toContain('status=completed')
        expect(sendCalls[0]!.text).toContain('batch')
        expect(sendCalls[0]!.text).toContain('Continue.')

        engine.patchSessionJob(session.id, 'batch', {
            status: 'completed',
            expectedRunId: 'run-wake-1',
        })
        await new Promise((r) => setTimeout(r, 50))
        expect(sendCalls).toHaveLength(1)

        store.close()
    })

    it('releases claim on no_machine_online and retries after recovery', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-retry', { path: '/tmp', flavor: 'cursor' }, null, 'default')

        const engine = stubEngine(store)
        ;(engine as unknown as { jobWakeRetryBaseMs: number }).jobWakeRetryBaseMs = 20
        const sessions = (engine as unknown as { _sessions: Map<string, { id: string; namespace: string; active: boolean }> })._sessions
        sessions.set(session.id, { id: session.id, namespace: 'default', active: false })

        let resumeCalls = 0
        const sendCalls: string[] = []
        ;(engine as unknown as {
            resumeSession: (id: string, ns: string) => Promise<
                | { type: 'success'; sessionId: string }
                | { type: 'error'; code: string; message: string }
            >
        }).resumeSession = async (id) => {
            resumeCalls += 1
            if (resumeCalls === 1) {
                return { type: 'error', code: 'no_machine_online', message: 'No machine online' }
            }
            sessions.set(id, { id, namespace: 'default', active: true })
            return { type: 'success', sessionId: id }
        }
        ;(engine as unknown as {
            sendMessage: (id: string, payload: { text: string; localId?: string | null }) => Promise<void>
        }).sendMessage = async (_id, payload) => {
            sendCalls.push(payload.localId ?? '')
        }

        engine.upsertSessionJob(session.id, 'batch', {
            label: 'batch',
            status: 'running',
            runId: 'run-offline',
            wakeOnTerminal: true,
        })
        engine.patchSessionJob(session.id, 'batch', {
            status: 'completed',
            expectedRunId: 'run-offline',
        })

        for (let i = 0; i < 40 && store.sessionJobs.get(session.id, 'batch')?.wakeEmittedRunId; i++) {
            await new Promise((r) => setTimeout(r, 10))
        }
        expect(store.sessionJobs.get(session.id, 'batch')?.wakeEmittedRunId).toBeUndefined()
        expect(sendCalls).toHaveLength(0)

        for (let i = 0; i < 80 && sendCalls.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 20))
        }
        expect(resumeCalls).toBeGreaterThanOrEqual(2)
        expect(sendCalls).toEqual(['hapi-job-wake:batch:run-offline'])
        expect(store.sessionJobs.get(session.id, 'batch')?.wakeEmittedRunId).toBe('run-offline')

        store.close()
    })

    it('requeues pending wakes after rapid-retry budget on machine recovery', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-budget', { path: '/tmp', flavor: 'cursor' }, null, 'default')
        const engine = stubEngine(store)
        ;(engine as unknown as { jobWakeRetryBaseMs: number }).jobWakeRetryBaseMs = 5
        ;(engine as unknown as { constructor: { JOB_WAKE_RETRY_MAX_ATTEMPTS: number } })
        // Cap via prototype static — SyncEngine.JOB_WAKE_RETRY_MAX_ATTEMPTS is private static 8;
        // force budget exhaustion quickly by failing every resume and waiting.
        const sessions = (engine as unknown as { _sessions: Map<string, { id: string; namespace: string; active: boolean }> })._sessions
        sessions.set(session.id, { id: session.id, namespace: 'default', active: false })

        let resumeCalls = 0
        const sendCalls: string[] = []
        ;(engine as unknown as {
            resumeSession: () => Promise<{ type: 'error'; code: string; message: string }>
        }).resumeSession = async () => {
            resumeCalls += 1
            return { type: 'error', code: 'no_machine_online', message: 'offline' }
        }
        ;(engine as unknown as {
            sendMessage: (id: string, payload: { localId?: string | null }) => Promise<void>
        }).sendMessage = async (_id, payload) => {
            sendCalls.push(payload.localId ?? '')
        }
        ;(engine as unknown as {
            resolveAttachedJobSessionId: (id: string) => string
            resolveAttachedJobKey: (_a: string, _b: string, key: string) => string
        }).resolveAttachedJobSessionId = (id) => id
        ;(engine as unknown as {
            resolveAttachedJobKey: (_a: string, _b: string, key: string) => string
        }).resolveAttachedJobKey = (_a, _b, key) => key

        engine.upsertSessionJob(session.id, 'batch', {
            label: 'batch',
            status: 'completed',
            runId: 'run-budget',
            wakeOnTerminal: true,
        })

        for (let i = 0; i < 200 && resumeCalls < 9; i++) {
            await new Promise((r) => setTimeout(r, 20))
        }
        expect(resumeCalls).toBeGreaterThanOrEqual(8)
        expect(sendCalls).toHaveLength(0)
        expect(store.sessionJobs.listPendingTerminalWakes().map((j) => j.key)).toContain('batch')

        // Recovery: resume succeeds; requeue scans pending.
        ;(engine as unknown as {
            resumeSession: (id: string) => Promise<{ type: 'success'; sessionId: string }>
        }).resumeSession = async (id) => {
            resumeCalls += 1
            sessions.set(id, { id, namespace: 'default', active: true })
            return { type: 'success', sessionId: id }
        }
        engine.requeuePendingJobTerminalWakes()
        for (let i = 0; i < 80 && sendCalls.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 20))
        }
        expect(sendCalls).toEqual(['hapi-job-wake:batch:run-budget'])
        store.close()
    })

    it('follows job-owner redirect when releasing and retrying a deferred wake', async () => {
        const store = new Store(':memory:')
        const source = store.sessions.getOrCreateSession('wake-src', { path: '/tmp', flavor: 'cursor' }, null, 'default')
        const target = store.sessions.getOrCreateSession('wake-dst', { path: '/tmp', flavor: 'cursor' }, null, 'default')
        const engine = stubEngine(store)
        ;(engine as unknown as { jobWakeRetryBaseMs: number }).jobWakeRetryBaseMs = 15
        const sessions = (engine as unknown as { _sessions: Map<string, { id: string; namespace: string; active: boolean; metadata?: Record<string, unknown> }> })._sessions
        sessions.set(source.id, {
            id: source.id,
            namespace: 'default',
            active: false,
            metadata: { jobsTransferredToSessionId: target.id },
        })
        sessions.set(target.id, { id: target.id, namespace: 'default', active: false })

        // Job lives on target (post-transfer); wake scheduled against source id.
        store.sessionJobs.upsert(target.id, 'batch', {
            label: 'batch',
            status: 'completed',
            runId: 'run-xfer',
            wakeOnTerminal: true,
        })

        let resumeCalls = 0
        const sendCalls: Array<{ sessionId: string; localId: string }> = []
        ;(engine as unknown as {
            resumeSession: (id: string) => Promise<
                | { type: 'success'; sessionId: string }
                | { type: 'error'; code: string; message: string }
            >
        }).resumeSession = async (id) => {
            resumeCalls += 1
            if (resumeCalls === 1) {
                return { type: 'error', code: 'no_machine_online', message: 'offline' }
            }
            sessions.set(id, { ...(sessions.get(id) ?? { id, namespace: 'default', active: true }), active: true })
            return { type: 'success', sessionId: id }
        }
        ;(engine as unknown as {
            sendMessage: (id: string, payload: { localId?: string | null }) => Promise<void>
        }).sendMessage = async (id, payload) => {
            sendCalls.push({ sessionId: id, localId: payload.localId ?? '' })
        }
        ;(engine as unknown as {
            resolveAttachedJobSessionId: (id: string) => string
        }).resolveAttachedJobSessionId = (id) => (id === source.id ? target.id : id)
        ;(engine as unknown as {
            resolveAttachedJobKey: (_a: string, _b: string, key: string) => string
        }).resolveAttachedJobKey = (_a, _b, key) => key

        // Claim against redirected owner via maybeSchedule from source id.
        ;(engine as unknown as {
            maybeScheduleJobTerminalWake: (sessionId: string, jobKey: string) => void
        }).maybeScheduleJobTerminalWake(source.id, 'batch')

        for (let i = 0; i < 40 && store.sessionJobs.get(target.id, 'batch')?.wakeEmittedRunId; i++) {
            await new Promise((r) => setTimeout(r, 10))
        }
        // First attempt claimed+released on target (redirected).
        expect(store.sessionJobs.get(target.id, 'batch')?.wakeEmittedRunId).toBeUndefined()

        for (let i = 0; i < 80 && sendCalls.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 20))
        }
        expect(sendCalls).toEqual([{ sessionId: target.id, localId: 'hapi-job-wake:batch:run-xfer' }])
        expect(store.sessionJobs.get(target.id, 'batch')?.wakeEmittedRunId).toBe('run-xfer')
        store.close()
    })

    it('drops delayed wake when key is reused by a new run mid-resume', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-fence', { path: '/tmp', flavor: 'cursor' }, null, 'default')
        const engine = stubEngine(store)
        const sessions = (engine as unknown as { _sessions: Map<string, { id: string; namespace: string; active: boolean }> })._sessions
        sessions.set(session.id, { id: session.id, namespace: 'default', active: false })

        const sendCalls: string[] = []
        let resumeGate!: () => void
        const resumeBlocked = new Promise<void>((resolve) => {
            resumeGate = resolve
        })
        ;(engine as unknown as {
            resumeSession: (id: string) => Promise<{ type: 'success'; sessionId: string }>
        }).resumeSession = async (id) => {
            await resumeBlocked
            sessions.set(id, { id, namespace: 'default', active: true })
            return { type: 'success', sessionId: id }
        }
        ;(engine as unknown as {
            sendMessage: (id: string, payload: { text: string; localId?: string | null }) => Promise<void>
        }).sendMessage = async (_id, payload) => {
            sendCalls.push(payload.text)
        }

        engine.upsertSessionJob(session.id, 'batch', {
            label: 'batch-a',
            status: 'completed',
            runId: 'run-a',
            wakeOnTerminal: true,
            wakePrompt: 'Continue A',
        })
        // Claim starts delivery; resume is blocked until we reuse the key.
        for (let i = 0; i < 40 && store.sessionJobs.get(session.id, 'batch')?.wakeEmittedRunId !== 'pending:run-a'; i++) {
            await new Promise((r) => setTimeout(r, 10))
        }
        expect(store.sessionJobs.get(session.id, 'batch')?.wakeEmittedRunId).toBe('pending:run-a')

        // Key reuse: new supervised run B (clears prior wake claim via upsert).
        store.sessionJobs.upsert(session.id, 'batch', {
            label: 'batch-b',
            status: 'running',
            runId: 'run-b',
            wakeOnTerminal: false,
        })
        resumeGate()
        for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 10))
        }
        expect(sendCalls).toHaveLength(0)
        expect(store.sessionJobs.get(session.id, 'batch')?.runId).toBe('run-b')
        store.close()
    })
})

describe('SyncEngine wake requeue on machine-updated (#1489)', () => {
    it('requeues when runner state marks machine online before first heartbeat', () => {
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const machine = engine.getOrCreateMachine(
                'wake-reconnect-machine',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.0.0' },
                null,
                'default'
            )
            const machines = (engine as unknown as {
                machineCache: {
                    refreshMachine: (id: string) => { active?: boolean; runnerStateVersion: number } | null
                    getMachine: (id: string) => {
                        active?: boolean
                        activeAt?: number
                        runnerStateVersion: number
                    } | undefined
                    expireInactive: (now?: number) => void
                }
            }).machineCache
            // Production offline is memory-only (expireInactive); SQLite stays
            // active=1 until the next runner-state write. Mirror that so the
            // refreshMachine activeAt merge matches reconnect.
            const cached = machines.getMachine(machine.id)!
            cached.active = true
            cached.activeAt = Date.now() - 60_000
            machines.expireInactive(Date.now())
            expect(machines.getMachine(machine.id)?.active).toBe(false)

            let requeues = 0
            const original = engine.requeuePendingJobTerminalWakes.bind(engine)
            engine.requeuePendingJobTerminalWakes = () => {
                requeues += 1
                original()
            }

            const version = machines.getMachine(machine.id)!.runnerStateVersion
            const updated = store.machines.updateMachineRunnerState(
                machine.id,
                { status: 'running', pid: 1 },
                version,
                'default'
            )
            expect(updated.result).toBe('success')

            engine.handleRealtimeEvent({ type: 'machine-updated', machineId: machine.id })
            expect(machines.getMachine(machine.id)?.active).toBe(true)
            expect(requeues).toBe(1)

            // Already online — subsequent state refreshes must not requeue again.
            engine.handleRealtimeEvent({ type: 'machine-updated', machineId: machine.id })
            expect(requeues).toBe(1)

            // Heartbeat after state-online must also not double-fire offline→online.
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })
            expect(requeues).toBe(1)
        } finally {
            engine.stop()
            store.close()
        }
    })
})
