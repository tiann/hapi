import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import type { WebAppEnv } from '../../middleware/auth'
import { Store } from '../../../store'
import { OPENCODE_LOCAL_SESSION_SOURCE, PI_LOCAL_SESSION_SOURCE } from './sources'
import { createLocalSessionRoutes } from './createLocalSessionRoutes'
import { importPiSession } from '../piSessions'

/**
 * Pinning tests for the generic-route Pi/OpenCode import semantics: gaps
 * without a cursor and HAPI-created sessions fail closed, imports are atomic
 * and serialize, vanished sessions fail with import_failed, Pi gets the
 * 200-session import cap, and machine selection prefers the cwd owner. The
 * legacy route test files stay untouched.
 */

function machine(id: string, workspaceRoots: string[] = []): Machine {
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
            workspaceRoots,
            capabilities: ['local-session-import']
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userContent(text: string) {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const
}

function piSummary(id = 'native-1'): LocalTranscriptSummary {
    return {
        flavor: 'pi',
        id,
        title: `Pi ${id}`,
        lastUserMessage: 'hello',
        cwd: '/workspace/b',
        file: `/tmp/${id}.jsonl`,
        modifiedAt: 1,
        messageCount: 1
    }
}

function piTranscript(id = 'native-1', texts: string[] = ['hello']): LocalTranscript {
    return {
        ...piSummary(id),
        messages: texts.map((text, index) => ({
            id: `pi:${id}:entry-${index + 1}:user`,
            createdAt: 1_000 + index,
            content: userContent(text),
            anchor: `entry-${index + 1}`,
            historyPoint: `entry-${index + 1}`
        })),
        anchorOrder: texts.map((_, index) => `entry-${index + 1}`),
        cursor: `entry-${texts.length}`
    }
}

function opencodeTranscript(id: string, texts: string[]): LocalTranscript {
    return {
        flavor: 'opencode',
        id,
        title: `OpenCode ${id}`,
        lastUserMessage: texts.at(-1) ?? null,
        cwd: '/workspace/b',
        file: '/tmp/opencode.db',
        modifiedAt: 1,
        messages: texts.map((text, index) => ({
            id: `opencode:${id}:msg-${index + 1}:part-1`,
            createdAt: 1_000 + index,
            content: userContent(text)
        }))
    }
}

function harness(overrides: {
    machines?: Machine[]
    transcripts?: LocalTranscript[]
    summaries?: LocalTranscriptSummary[]
} = {}) {
    const store = new Store(':memory:')
    const calls: Array<{ machineId: string; payload: unknown }> = []
    const appliedConfigs: Array<Record<string, unknown>> = []
    const machines = overrides.machines ?? [machine('m-1', ['/workspace/a'])]
    const transcripts = overrides.transcripts ?? [piTranscript()]
    const summaries = overrides.summaries ?? transcripts.map(({ messages: _messages, ...summary }) => summary as LocalTranscriptSummary)
    const engine = {
        getOnlineMachinesByNamespace: () => machines,
        getSessionsByNamespace: () => [],
        listLocalSessionsForMachine: async (machineId: string, payload: { flavor: string; sessionIds?: string[] | null }) => {
            calls.push({ machineId, payload })
            const wanted = payload.sessionIds ?? null
            const source = wanted
                ? transcripts.filter((transcript) => (wanted as string[]).includes(transcript.id))
                : summaries
            return { success: true, sessions: source }
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
        sources: [PI_LOCAL_SESSION_SOURCE, OPENCODE_LOCAL_SESSION_SOURCE]
    }))
    return { store, engine, app, calls, appliedConfigs }
}

function createImportedPiSession(store: Store, nativeId: string, localIds: string[], metadata: Record<string, unknown> = {}) {
    const created = store.sessions.getOrCreateSession(`pi-import:m-1:${nativeId}`, {
        path: '/workspace/b',
        host: 'm-1.local',
        machineId: 'm-1',
        flavor: 'pi',
        piSessionId: nativeId,
        lifecycleState: 'archived',
        ...metadata
    }, {}, 'default')
    for (const localId of localIds) {
        store.messages.addImportedMessage(created.id, userContent(`stored ${localId}`), localId, 1)
    }
    return created
}

describe('generic Pi import route', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('diverges on a gap without a cursor', async () => {
        const { app, store } = harness({
            transcripts: [{
                ...piTranscript('native-gap', ['moved']),
                messages: [{
                    id: 'pi:native-gap:entry-2:user',
                    createdAt: 2_000,
                    content: userContent('moved'),
                    anchor: 'entry-2',
                    historyPoint: 'entry-2'
                }],
                anchorOrder: ['entry-2'],
                cursor: 'entry-2'
            }],
            summaries: [{
                flavor: 'pi',
                id: 'native-gap',
                title: 'Pi native-gap',
                cwd: '/workspace/b',
                file: '/tmp/native-gap.jsonl',
                modifiedAt: 1,
                messageCount: 1
            }]
        })
        stores.push(store)
        // The stored session kept entry-1; the transcript's active branch no
        // longer contains it and no cursor was persisted: the pre-registry
        // importer appended the moved entry as a duplicate, the registry
        // fails closed instead.
        const stored = createImportedPiSession(store, 'native-gap', ['pi:native-gap:entry-1:user'])
        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['native-gap'] })
        })
        const body = await response.json() as { results: Array<{ error?: { code: string } }> }
        expect(body.results[0]!.error).toMatchObject({ code: 'transcript_diverged' })
        expect(store.messages.getAllMessages(stored.id)).toHaveLength(1)
    })

    it('reports already_in_hapi for a HAPI-created session', async () => {
        const { app, store } = harness()
        stores.push(store)
        const created = store.sessions.getOrCreateSession('hapi-native', {
            machineId: 'm-1',
            flavor: 'pi',
            piSessionId: 'native-1'
        }, {}, 'default')
        store.messages.addImportedMessage(created.id, userContent('typed in HAPI'), 'local-1', 1)
        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['native-1'] })
        })
        const body = await response.json() as { results: Array<{ error?: { code: string }; hapiSessionId?: string }> }
        expect(body.results[0]).toMatchObject({ hapiSessionId: created.id, error: { code: 'already_in_hapi' } })
        expect(store.messages.getAllMessages(created.id)).toHaveLength(1)
    })

    it('rolls the whole Pi import back on insert failure', async () => {
        const { app, store } = harness({
            transcripts: [piTranscript('native-1', ['one', 'two'])]
        })
        stores.push(store)
        const original = store.messages.addImportedMessage.bind(store.messages)
        let calls = 0
        ;(store.messages as { addImportedMessage: typeof original }).addImportedMessage = (
            (sessionId: string, content: unknown, localId: string, createdAt: number) => {
                calls += 1
                if (calls === 2) throw new Error('boom')
                return original(sessionId, content, localId, createdAt)
            }
        ) as typeof original
        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['native-1'] })
        })
        const body = await response.json() as { results: Array<{ error?: { code: string } }> }
        expect(body.results[0]!.error).toMatchObject({ code: 'import_failed' })
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('serializes concurrent Pi imports of one native session', async () => {
        const { app, store } = harness()
        stores.push(store)
        const [first, second] = await Promise.all([
            app.request('/api/pi/import-sessions', { method: 'POST', body: JSON.stringify({ sessionIds: ['native-1'] }) }),
            app.request('/api/pi/import-sessions', { method: 'POST', body: JSON.stringify({ sessionIds: ['native-1'] }) })
        ])
        const firstBody = await first.json() as { results: Array<{ action?: string }> }
        const secondBody = await second.json() as { results: Array<{ action?: string }> }
        const actions = [firstBody.results[0]!.action, secondBody.results[0]!.action].sort()
        expect(actions).toEqual(['created', 'unchanged'])
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
        expect(store.messages.getAllMessages(store.sessions.getSessionsByNamespace('default')[0]!.id)).toHaveLength(1)
    })

    it('applies the requested launch config to a Pi import', async () => {
        const { app, store, appliedConfigs } = harness()
        stores.push(store)
        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['native-1'], model: 'gemini-3.8-flash', modelReasoningEffort: 'low' })
        })
        const body = await response.json() as { success: boolean }
        expect(body.success).toBe(true)
        expect(appliedConfigs).toEqual([{ model: 'gemini-3.8-flash', modelReasoningEffort: 'low' }])
        const session = store.sessions.getSessionsByNamespace('default')[0]!
        expect(session.model).toBe('gemini-3.8-flash')
        expect(session.effort).toBe('low')
    })

    it('rejects more Pi sessions than the scan limit', async () => {
        const { app } = harness()
        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `pi-${index}`) })
        })
        expect(response.status).toBe(400)
    })

    it('prefers the machine that owns the cwd', async () => {
        const owner = machine('m-2', ['/workspace/b'])
        const other = machine('m-1', ['/workspace/a'])
        const { app, calls } = harness({ machines: [other, owner] })
        const listResponse = await app.request('/api/pi/sessions?cwd=/workspace/b/sub')
        const listBody = await listResponse.json() as { machineId?: string }
        expect(listBody.machineId).toBe('m-2')
        const importResponse = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['native-1'], cwd: '/workspace/b/sub' })
        })
        const importBody = await importResponse.json() as { machineId?: string }
        expect(importBody.machineId).toBe('m-2')
        expect(calls[0]!.machineId).toBe('m-2')
    })
})

describe('generic OpenCode import route', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('reports already_in_hapi for a HAPI-created session', async () => {
        const { app, store } = harness({
            transcripts: [opencodeTranscript('native-oc', ['native history'])],
            summaries: [{
                flavor: 'opencode',
                id: 'native-oc',
                title: 'OpenCode native-oc',
                cwd: '/workspace/b',
                file: '/tmp/opencode.db',
                modifiedAt: 1
            }]
        })
        stores.push(store)
        const created = store.sessions.getOrCreateSession('hapi-oc', {
            machineId: 'm-1',
            flavor: 'opencode',
            opencodeSessionId: 'native-oc'
        }, {}, 'default')
        store.messages.addImportedMessage(created.id, userContent('typed in HAPI'), 'local-1', 1)
        const response = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['native-oc'] })
        })
        const body = await response.json() as { results: Array<{ error?: { code: string }; hapiSessionId?: string }> }
        expect(body.results[0]).toMatchObject({ hapiSessionId: created.id, error: { code: 'already_in_hapi' } })
        expect(store.messages.getAllMessages(created.id)).toHaveLength(1)
    })
})

describe('Pi sync import wrapper', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('fails closed when a captured Pi session disappears', () => {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            getSessionsByNamespace: () => []
        } as unknown as SyncEngine
        const created = createImportedPiSession(store, 'native-vanish', ['pi:native-vanish:entry-1:user'])
        const captured = store.sessions.getSession(created.id)!
        expect(store.sessions.deleteSession(created.id, 'default')).toBe(true)
        const result = importPiSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('m-1'),
            transcript: {
                id: 'native-vanish',
                title: 'Pi native-vanish',
                cwd: '/workspace/b',
                file: '/tmp/native-vanish.jsonl',
                modifiedAt: 1,
                messageCount: 1,
                messages: [{
                    localId: 'pi:native-vanish:entry-1:user',
                    entryId: 'entry-1',
                    parentEntryId: null,
                    createdAt: 1_000,
                    content: userContent('hello')
                }],
                activeEntryIds: ['entry-1']
            },
            existingSession: captured
        })
        expect(result.error).toMatchObject({ code: 'import_failed' })
    })
})