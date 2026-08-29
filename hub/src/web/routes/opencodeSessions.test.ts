import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { OpencodeLocalSessionSummary, OpencodeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createOpencodeSessionRoutes, importOpencodeSession } from './opencodeSessions'

function machine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: `${id}.local`,
            platform: 'darwin',
            happyCliVersion: 'test'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userMessage(sessionId: string, localId: string, text: string, createdAt: number) {
    return {
        localId: `opencode:${sessionId}:${localId}`,
        createdAt,
        content: {
            role: 'user' as const,
            content: { type: 'text' as const, text },
            meta: { sentFrom: 'cli' as const }
        }
    }
}

function transcript(
    sessionId: string,
    messages: Array<ReturnType<typeof userMessage>>
): OpencodeLocalSessionWithMessages {
    const lastUser = [...messages].reverse().find((message) => message.content.role === 'user')
    return {
        id: sessionId,
        title: `Session ${sessionId}`,
        lastUserMessage: lastUser?.content.role === 'user' ? lastUser.content.content.text : null,
        cwd: '/tmp/project',
        file: `/tmp/${sessionId}.json`,
        modifiedAt: messages.at(-1)?.createdAt ?? 1,
        messages
    }
}

describe('OpenCode session import', () => {
    const stores: Store[] = []

    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    function setup() {
        const store = new Store(':memory:')
        stores.push(store)
        const events: unknown[] = []
        const engine = {
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: (event: unknown) => events.push(event)
        } as unknown as SyncEngine
        return { store, engine, events }
    }

    function appWith(store: Store, engine: SyncEngine) {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createOpencodeSessionRoutes({ store, getSyncEngine: () => engine }))
        return app
    }

    it('returns 503 when no online machine is available', async () => {
        const { store } = setup()
        const engine = {
            getOnlineMachinesByNamespace: () => []
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/sessions')

        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({ success: false, sessions: [] })
    })

    it('annotates summaries with hapiSessionId of already-imported sessions', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        store.sessions.getOrCreateSession('imported-native-1', {
            flavor: 'opencode',
            machineId: selectedMachine.id,
            opencodeSessionId: 'native-1'
        }, {}, 'default')
        const summaries: OpencodeLocalSessionSummary[] = [
            transcript('native-1', []),
            transcript('native-2', [])
        ]
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listOpencodeSessionsForMachine: async () => ({ success: true, sessions: summaries })
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/sessions?machineId=machine-1')

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            success: true,
            machineId: 'machine-1',
            sessions: [
                { id: 'native-1', hapiSessionId: expect.any(String) },
                { id: 'native-2' }
            ]
        })
    })

    it('creates a HAPI session with flavor/opencodeSessionId metadata and appended messages', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        const transcripts = [
            transcript('native-create', [
                userMessage('native-create', 'msg-1', 'one', 1_000)
            ])
        ]
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listOpencodeSessionsForMachine: async (_machineId: string, _cwd: string | null, sessionIds?: string[]) => {
                expect(sessionIds).toEqual(['native-create'])
                return { success: true, sessions: transcripts }
            },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ machineId: selectedMachine.id, sessionIds: ['native-create'] })
        })

        expect(response.status).toBe(200)
        const payload = await response.json() as { results: Array<{ hapiSessionId?: string; action?: string; appended?: number }> }
        expect(payload).toMatchObject({
            success: true,
            machineId: 'machine-1',
            results: [{ action: 'created', appended: 1 }]
        })
        const hapiSessionId = payload.results[0]!.hapiSessionId!
        const stored = store.sessions.getSession(hapiSessionId)!
        expect(stored.metadata).toMatchObject({
            flavor: 'opencode',
            machineId: 'machine-1',
            opencodeSessionId: 'native-create'
        })
        expect(store.messages.getAllMessages(hapiSessionId)).toHaveLength(1)
        expect(store.messages.getAllMessages(hapiSessionId)[0]).toMatchObject({
            localId: 'opencode:native-create:msg-1',
            invokedAt: 1_000
        })
    })

    it('appends only the delta when re-importing an extended transcript', async () => {
        const { store, engine } = setup()
        const first = transcript('native-delta', [
            userMessage('native-delta', 'msg-1', 'one', 1_000)
        ])
        const initial = importOpencodeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: first })
        expect(initial).toMatchObject({ action: 'created', appended: 1 })

        const unchanged = importOpencodeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: first })
        expect(unchanged).toMatchObject({ action: 'unchanged', appended: 0 })

        const extended = transcript('native-delta', [
            userMessage('native-delta', 'msg-1', 'one', 1_000),
            userMessage('native-delta', 'msg-2', 'two', 2_000)
        ])
        const updated = importOpencodeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: extended })
        expect(updated).toMatchObject({ hapiSessionId: initial.hapiSessionId, action: 'updated', appended: 1 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)).toHaveLength(2)
    })

    it('fails with transcript_diverged and keeps stored history intact on content change', () => {
        const { store, engine } = setup()
        const source = transcript('native-diverged', [
            userMessage('native-diverged', 'msg-1', 'one', 1_000)
        ])
        const first = importOpencodeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })

        const rewritten = transcript('native-diverged', [
            userMessage('native-diverged', 'msg-1', 'changed', 1_000)
        ])
        const result = importOpencodeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: rewritten })
        expect(result.error?.code).toBe('transcript_diverged')
        expect(result.hapiSessionId).toBe(first.hapiSessionId)
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(1)
        expect(store.messages.getAllMessages(first.hapiSessionId!)[0]).toMatchObject({
            localId: 'opencode:native-diverged:msg-1'
        })
    })

    it('fails when new native entries are inserted ahead of the imported boundary', () => {
        const { store, engine } = setup()
        const first = importOpencodeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            transcript: transcript('native-insert', [
                userMessage('native-insert', 'msg-1', 'one', 1_000),
                userMessage('native-insert', 'msg-2', 'two', 2_000)
            ])
        })
        expect(first).toMatchObject({ action: 'created' })

        const reordered = importOpencodeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            transcript: transcript('native-insert', [
                userMessage('native-insert', 'msg-new', 'new', 500),
                userMessage('native-insert', 'msg-1', 'one', 1_000),
                userMessage('native-insert', 'msg-2', 'two', 2_000)
            ])
        })
        expect(reordered.error?.code).toBe('transcript_diverged')
    })

    it('fails closed when HAPI continuation happened after an import and native history advanced', () => {
        const { store, engine } = setup()
        const first = importOpencodeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            transcript: transcript('native-tail', [userMessage('native-tail', 'msg-1', 'one', 1_000)])
        })
        expect(first.hapiSessionId).toBeTruthy()
        const continuation = store.messages.addImportedMessage(first.hapiSessionId!, {
            role: 'user',
            content: { type: 'text', text: 'live follow-up' },
            meta: { sentFrom: 'web' as const }
        }, 'hapi-live-msg-1', 5_000)
        expect(continuation.inserted).toBe(true)

        const extended = importOpencodeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            transcript: transcript('native-tail', [
                userMessage('native-tail', 'msg-1', 'one', 1_000),
                userMessage('native-tail', 'msg-2', 'two', 2_000)
            ])
        })
        expect(extended.error?.code).toBe('transcript_diverged')
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(2)
    })

    it('applies requested launch config to the imported session before reopen', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        const applied: Array<Record<string, unknown>> = []
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listOpencodeSessionsForMachine: async () => ({
                success: true,
                sessions: [transcript('native-launch', [userMessage('native-launch', 'msg-1', 'one', 1_000)])]
            }),
            applySessionConfig: async (sessionId: string, config: Record<string, unknown>) => {
                applied.push({ sessionId, config })
            },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionIds: ['native-launch'],
                model: 'opengpt/5.2-max',
                modelReasoningEffort: 'high',
                permissionMode: 'yolo'
            })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { results: Array<{ hapiSessionId?: string }> }
        const importedSessionId = body.results[0]?.hapiSessionId
        expect(importedSessionId).toBeTruthy()
        expect(applied).toEqual([{ sessionId: importedSessionId, config: { model: 'opengpt/5.2-max', modelReasoningEffort: 'high', permissionMode: 'yolo' } }])
    })

    it('reports a per-session config_failed result instead of a 500 when applySessionConfig throws', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listOpencodeSessionsForMachine: async () => ({
                success: true,
                sessions: [transcript('native-cfgfail', [userMessage('native-cfgfail', 'msg-1', 'one', 1_000)])]
            }),
            applySessionConfig: async () => {
                throw new Error('rpc timeout')
            },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['native-cfgfail'], permissionMode: 'yolo' })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { success: boolean; results: Array<{ hapiSessionId?: string; error?: { code: string; message: string } }> }
        expect(body.success).toBe(false)
        expect(body.results[0]?.error).toMatchObject({ code: 'config_failed', message: 'rpc timeout' })
        expect(body.results[0]?.hapiSessionId).toBeTruthy()
    })

    it('resets persisted launch config when the picker sends explicit defaults', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        const applied: Array<{ sessionId: string; config: Record<string, unknown> }> = []
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listOpencodeSessionsForMachine: async () => ({
                success: true,
                sessions: [transcript('native-reset', [userMessage('native-reset', 'msg-1', 'one', 1_000)])]
            }),
            applySessionConfig: async (sessionId: string, config: Record<string, unknown>) => {
                applied.push({ sessionId, config })
            },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sessionIds: ['native-reset'],
                model: null,
                modelReasoningEffort: null,
                permissionMode: 'default'
            })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { results: Array<{ hapiSessionId?: string }> }
        const importedSessionId: string | undefined = body.results[0]?.hapiSessionId
        if (!importedSessionId) throw new Error('expected hapiSessionId in import result')
        const appliedCall = applied[0]
        if (!appliedCall) throw new Error('expected applySessionConfig to be called')
        expect(appliedCall.sessionId).toBe(importedSessionId)
        expect(Object.keys(appliedCall!.config)).toEqual(['model', 'modelReasoningEffort', 'permissionMode'])
        expect(appliedCall!.config.model).toBeNull()
        expect(appliedCall!.config.modelReasoningEffort).toBeNull()
        expect(appliedCall!.config.permissionMode).toBe('default')
    })

    it('does not touch launch config when the request omits the fields', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        let applyCalls = 0
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listOpencodeSessionsForMachine: async () => ({
                success: true,
                sessions: [transcript('native-omit', [userMessage('native-omit', 'msg-1', 'one', 1_000)])]
            }),
            applySessionConfig: async () => { applyCalls += 1 },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['native-omit'] })
        })
        expect(response.status).toBe(200)
        expect(applyCalls).toBe(0)
    })

    it('rejects a permission mode that is not allowed for the opencode flavor', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listOpencodeSessionsForMachine: async () => ({ success: true, sessions: [] })
        } as unknown as SyncEngine
        const app = appWith(store, engine)

        const response = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['native-x'], permissionMode: 'acceptEdits' })
        })
        expect(response.status).toBe(400)
    })

    it('fails with session_active when the target session is active and new messages exist', () => {
        const { store, engine } = setup()
        const first = importOpencodeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            transcript: transcript('native-active', [userMessage('native-active', 'msg-1', 'one', 1_000)])
        })
        store.sessions.setSessionActive(first.hapiSessionId!, true, 2_000, 'default')
        const extended = transcript('native-active', [
            userMessage('native-active', 'msg-1', 'one', 1_000),
            userMessage('native-active', 'msg-2', 'two', 2_000)
        ])

        const result = importOpencodeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: extended })
        expect(result.error?.code).toBe('session_active')
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(1)
    })
})
