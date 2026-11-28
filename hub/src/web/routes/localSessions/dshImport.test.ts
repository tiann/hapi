import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import { dshToTranscript } from '@hapi/protocol/localTranscript'
import type { DshLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import type { WebAppEnv } from '../../middleware/auth'
import { Store } from '../../../store'
import { DSH_LOCAL_SESSION_SOURCE } from './sources'
import { createLocalSessionRoutes } from './createLocalSessionRoutes'

/**
 * DSH through the generic import route. Transcripts here have the exact shape
 * the runner's disk reader emits: rows keyed `<flavor>:<nativeId>:<seq>` (+ a
 * block index for every further block of one assistant message), payloads in
 * the CodexMessage shapes the live ACP bridge sends, and — for sessions the
 * reader cannot hand over — a summary carrying `importError`.
 */

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
            happyCliVersion: 'test',
            workspaceRoots: ['/workspace/a'],
            capabilities: ['local-session-import']
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

const agent = (data: unknown) => ({ role: 'agent', content: { type: 'codex', data }, meta: { sentFrom: 'cli' } }) as const
const user = (text: string) => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }) as const

/** One user turn answered by a reasoning + text message and one tool call. */
function dshTranscript(id = 'dsh-native-1', turns = 1): LocalTranscript {
    const native: DshLocalSessionWithMessages = {
        id,
        title: '修复登录页',
        lastUserMessage: '再跑下测试',
        cwd: '/workspace/b',
        file: `/home/u/.dsh/sessions/--workspace-b--/${id}/session.v4.jsonl.zstd`,
        modifiedAt: 1,
        model: '["deepseek-official","glm-5.4"]',
        extra: { turns, model: 'glm-5.4' },
        messages: [
            { localId: `dsh:${id}:2`, createdAt: 1_000, content: user('帮我修一下登录页') },
            { localId: `dsh:${id}:4`, createdAt: 1_100, content: agent({ type: 'reasoning', message: '先看看路由', id: 'dsh-r:4' }) },
            { localId: `dsh:${id}:4:1`, createdAt: 1_100, content: agent({ type: 'message', message: '我来检查登录页代码。', id: 'msg-1' }) },
            { localId: `dsh:${id}:5`, createdAt: 1_200, content: agent({ type: 'tool-call', name: 'read_file', callId: 'call-1', input: { path: 'login.ts' }, status: 'in_progress' }) },
            { localId: `dsh:${id}:6`, createdAt: 1_300, content: agent({ type: 'tool-call-result', callId: 'call-1', output: 'const x = 1', is_error: false }) }
        ]
    }
    if (turns > 1) {
        native.messages.push(
            { localId: `dsh:${id}:9`, createdAt: 2_000, content: user('再跑下测试') },
            { localId: `dsh:${id}:10`, createdAt: 2_100, content: agent({ type: 'message', message: '好的。', id: 'msg-2' }) }
        )
    }
    return dshToTranscript(native)
}

function harness(transcripts: Array<LocalTranscript | LocalTranscriptSummary>) {
    const store = new Store(':memory:')
    const calls: Array<{ machineId: string; payload: { flavor: string; sessionIds?: string[] | null } }> = []
    const appliedConfigs: Array<Record<string, unknown>> = []
    const engine = {
        getOnlineMachinesByNamespace: () => [machine('m-1')],
        getSessionsByNamespace: () => [],
        listLocalSessionsForMachine: async (machineId: string, payload: { flavor: string; sessionIds?: string[] | null }) => {
            calls.push({ machineId, payload })
            const wanted = payload.sessionIds ?? null
            return {
                success: true,
                // List calls answer summaries; transcript calls answer the
                // requested sessions (or their `importError` stand-in).
                sessions: wanted
                    ? transcripts.filter((item) => wanted.includes(item.id))
                    : transcripts.map(({ ...item }) => {
                        if ('messages' in item) {
                            const { messages: _messages, ...summary } = item
                            return summary as LocalTranscriptSummary
                        }
                        return item
                    })
            }
        },
        recordSessionActivity: () => {},
        handleRealtimeEvent: () => {},
        applySessionConfig: async (_sessionId: string, config: Record<string, unknown>) => {
            appliedConfigs.push(config)
        }
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createLocalSessionRoutes({
        store,
        getSyncEngine: () => engine,
        sources: [DSH_LOCAL_SESSION_SOURCE]
    }))
    return { store, app, calls, appliedConfigs }
}

type ImportResult = {
    sessionId: string
    dshSessionId: string
    hapiSessionId?: string
    action?: 'created' | 'updated' | 'unchanged'
    appended?: number
    error?: { code: string; message: string }
}

async function importSessions(app: Hono<WebAppEnv>, sessionIds: string[], body: Record<string, unknown> = {}) {
    const response = await app.request('/api/dsh/import-sessions', {
        method: 'POST',
        body: JSON.stringify({ sessionIds, ...body })
    })
    expect(response.status).toBe(200)
    return (await response.json() as { success: boolean; results: ImportResult[] }).results
}

describe('DSH through the generic import route', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('imports a folded transcript, then tracks re-imports of the same native session', async () => {
        // The harness reads this array live, so swapping the transcript
        // stands in for the native session growing in dsh itself.
        const transcripts = [dshTranscript()]
        const { app, store, appliedConfigs } = harness(transcripts)
        stores.push(store)

        const [first] = await importSessions(app, ['dsh-native-1'])
        expect(first).toMatchObject({ dshSessionId: 'dsh-native-1', action: 'created' })
        expect(first!.error).toBeUndefined()

        const session = store.sessions.getSessionByNamespace(first!.hapiSessionId!, 'default')!
        expect(session.metadata).toMatchObject({ flavor: 'dsh', machineId: 'm-1', dshSessionId: 'dsh-native-1' })
        // The row path is the log's header cwd, which is what dsh session/resume compares.
        expect((session.metadata as { path?: string }).path).toBe('/workspace/b')
        expect(session.model).toBe('["deepseek-official","glm-5.4"]')
        // No effort is guessed from disk: the session adopts the level the
        // agent runs with when it starts.
        expect(session.modelReasoningEffort).toBeNull()
        expect(session.effort).toBeNull()

        const rows = store.messages.getAllMessages(session.id)
        expect(rows.map((row) => row.localId)).toEqual([
            'dsh:dsh-native-1:2', 'dsh:dsh-native-1:4', 'dsh:dsh-native-1:4:1', 'dsh:dsh-native-1:5', 'dsh:dsh-native-1:6'
        ])
        expect(appliedConfigs).toEqual([])

        // Same native session, nothing new: unchanged, no duplicate rows.
        const [again] = await importSessions(app, ['dsh-native-1'])
        expect(again).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(session.id)).toHaveLength(5)

        // The native session grew in dsh itself: the new turn is appended.
        transcripts[0] = dshTranscript('dsh-native-1', 2)
        const [grown] = await importSessions(app, ['dsh-native-1'])
        expect(grown).toMatchObject({ hapiSessionId: session.id, action: 'updated', appended: 2 })
        expect(store.messages.getAllMessages(session.id)).toHaveLength(7)
    })

    it('applies an effort picked in the form, and sends none when nothing was picked', async () => {
        const { app, store, appliedConfigs } = harness([dshTranscript()])
        stores.push(store)

        // The New Session form omits the key when nothing was picked.
        const [implicit] = await importSessions(app, ['dsh-native-1'])
        expect(store.sessions.getSessionByNamespace(implicit!.hapiSessionId!, 'default')!.modelReasoningEffort).toBeNull()
        expect(appliedConfigs).toEqual([])

        const { app: explicitApp, store: explicitStore, appliedConfigs: explicitConfigs } = harness([dshTranscript()])
        stores.push(explicitStore)
        const [picked] = await importSessions(explicitApp, ['dsh-native-1'], { modelReasoningEffort: 'low' })
        expect(picked!.action).toBe('created')
        expect(explicitConfigs.at(-1)).toMatchObject({ modelReasoningEffort: 'low' })
    })

    // What the runner answers for a session it listed but cannot hand over:
    // the session's summary carrying the reason (a real 83MB log, read on a
    // live install).
    const tooLarge: LocalTranscriptSummary = {
        flavor: 'dsh',
        id: 'dsh-huge',
        title: '巨大的会话',
        cwd: '/workspace/b',
        file: '/home/u/.dsh/sessions/x/dsh-huge/session.v4.jsonl.zstd',
        modifiedAt: 2,
        importError: { code: 'transcript_too_large', message: 'DSH session is too large to import (83.4MB compressed log).' }
    }

    it('reports a session the runner cannot hand over, without failing the rest of the batch', async () => {
        const { app, store } = harness([tooLarge, dshTranscript()])
        stores.push(store)

        const results = await importSessions(app, ['dsh-huge', 'dsh-native-1'])
        expect(results[0]).toMatchObject({
            dshSessionId: 'dsh-huge',
            error: { code: 'transcript_too_large', message: 'DSH session is too large to import (83.4MB compressed log).' }
        })
        expect(results[0]!.hapiSessionId).toBeUndefined()
        expect(results[1]).toMatchObject({ dshSessionId: 'dsh-native-1', action: 'created' })
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
    })

    it('never files a rejection that still carries an empty messages array as an empty transcript', async () => {
        // The first cut of the reader answered with `{ ...summary, messages: [],
        // importError }`; keyed on the presence of `messages`, the route filed
        // it as a created session with no rows and no error.
        const inlineRejection = { ...tooLarge, messages: [] } as unknown as LocalTranscript
        const { app, store } = harness([inlineRejection, dshTranscript()])
        stores.push(store)

        const results = await importSessions(app, ['dsh-huge', 'dsh-native-1'])
        expect(results[0]).toMatchObject({ dshSessionId: 'dsh-huge', error: { code: 'transcript_too_large' } })
        expect(results[0]!.hapiSessionId).toBeUndefined()
        expect(results[1]).toMatchObject({ dshSessionId: 'dsh-native-1', action: 'created' })
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
    })

    it('fetches one session per runner RPC so a batch never outgrows one transport frame', async () => {
        const { app, store, calls } = harness([dshTranscript('a'), dshTranscript('b'), dshTranscript('c')])
        stores.push(store)

        const results = await importSessions(app, ['a', 'b', 'c'])
        expect(results.map((result) => result.action)).toEqual(['created', 'created', 'created'])
        expect(calls).toHaveLength(3)
        for (const call of calls) {
            expect(call.payload.flavor).toBe('dsh')
            expect(call.payload.sessionIds).toHaveLength(1)
        }
        expect(calls.map((call) => call.payload.sessionIds![0])).toEqual(['a', 'b', 'c'])
    })

    it('lists sessions with their extras flattened and marks the ones already in HAPI', async () => {
        const { app, store } = harness([dshTranscript('dsh-native-1')])
        stores.push(store)
        await importSessions(app, ['dsh-native-1'])

        const response = await app.request('/api/dsh/sessions')
        expect(response.status).toBe(200)
        const body = await response.json() as {
            success: boolean
            machineId: string
            sessions: Array<Record<string, unknown>>
        }
        expect(body.success).toBe(true)
        expect(body.machineId).toBe('m-1')
        const [item] = body.sessions
        // The hub flattens `extra` and strips `launch`; the readable model id
        // rides the flattened extras so the dialog can search by model.
        expect(item).toMatchObject({
            id: 'dsh-native-1',
            title: '修复登录页',
            cwd: '/workspace/b',
            turns: 1,
            model: 'glm-5.4'
        })
        expect(item!.hapiSessionId).toMatch(/^[0-9a-f-]{36}$/)
        expect(item).not.toHaveProperty('launch')
        expect(item).not.toHaveProperty('extra')
    })
})
