import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { AttachedJobUpsert } from '@hapi/protocol'
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
})
