import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import type { WebAppEnv } from '../../middleware/auth'
import { Store } from '../../../store'
import { AGY_LOCAL_SESSION_SOURCE, CLAUDE_LOCAL_SESSION_SOURCE, CODEX_LOCAL_SESSION_SOURCE, OPENCODE_LOCAL_SESSION_SOURCE, PI_LOCAL_SESSION_SOURCE } from './sources'
import { createLocalSessionRoutes } from './createLocalSessionRoutes'
import { fetchLocalTranscriptSummaries, fetchLocalTranscriptsByIds } from './fetchLocalTranscripts'

function machine(id = 'm-1', capabilities: string[] = ['local-session-import']): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: `${id}.local`, platform: 'darwin', happyCliVersion: 'test', capabilities },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function piSummary(): LocalTranscriptSummary {
    return {
        flavor: 'pi',
        id: 'pi-1',
        title: 'Pi session',
        lastUserMessage: 'hello',
        cwd: '/tmp/project',
        file: '/tmp/pi-1.jsonl',
        modifiedAt: 1,
        messageCount: 3,
        launch: { model: 'gemini-3.8-flash', effort: 'low' },
        extra: { model: 'gemini-3.8-flash', thinkingLevel: 'low', leafEntryId: 'e3' }
    }
}

function piTranscript(): LocalTranscript {
    return {
        ...piSummary(),
        messages: [
            {
                id: 'pi:pi-1:e1:user',
                createdAt: 1,
                content: { role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' } },
                anchor: 'e1',
                historyPoint: 'e1'
            }
        ],
        anchorOrder: ['e1'],
        cursor: 'e1'
    }
}

function harness(overrides: {
    summaries?: Array<LocalTranscriptSummary | LocalTranscript>
    transcripts?: Array<LocalTranscriptSummary | LocalTranscript>
    machineCapabilities?: string[]
    rpcError?: string
    namespace?: string
    onlineMachines?: Machine[]
    sources?: import('./sources').HubLocalSessionSource[]
} = {}) {
    const store = new Store(':memory:')
    const calls: Array<{ method: string; payload: unknown }> = []
    const appliedConfigs: Array<Record<string, unknown>> = []
    const summaries = overrides.summaries ?? [piSummary()]
    const transcripts = overrides.transcripts ?? [piTranscript()]
    const machineInstance = machine('m-1', overrides.machineCapabilities ?? ['local-session-import'])
    const onlineMachines = overrides.onlineMachines ?? [machineInstance]
    const engine = {
        getOnlineMachinesByNamespace: () => onlineMachines,
        getSessionsByNamespace: () => [],
        listLocalSessionsForMachine: async (_machineId: string, payload: { flavor: string; sessionIds?: string[] | null }) => {
            calls.push({ method: 'listLocalSessions', payload })
            if (overrides.rpcError) return { success: false, error: overrides.rpcError }
            const wanted = payload.sessionIds ?? null
            const source = wanted ? transcripts : summaries
            return {
                success: true,
                sessions: wanted
                    ? source.filter((session) => 'messages' in session && (wanted as string[]).includes(session.id))
                    : source
            }
        },
        recordSessionActivity: () => {},
        handleRealtimeEvent: () => {},
        applySessionConfig: async (_sessionId: string, config: Record<string, unknown>) => {
            appliedConfigs.push(config)
        }
    } as unknown as SyncEngine
    const namespace = overrides.namespace ?? 'default'
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createLocalSessionRoutes({
        store,
        getSyncEngine: () => engine,
        sources: overrides.sources ?? [PI_LOCAL_SESSION_SOURCE, OPENCODE_LOCAL_SESSION_SOURCE, CODEX_LOCAL_SESSION_SOURCE]
    }))
    return { store, engine, app, calls, appliedConfigs }
}

describe('generic local session routes', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('lists Pi summaries with flattened extra fields and no flavor/launch keys', async () => {
        const { app } = harness()
        const response = await app.request('/api/pi/sessions')
        const body = await response.json() as { success: boolean; sessions: Array<Record<string, unknown>>; machineId?: string }
        expect(body.success).toBe(true)
        expect(body.machineId).toBe('m-1')
        expect(body.sessions[0]).toMatchObject({
            id: 'pi-1',
            model: 'gemini-3.8-flash',
            thinkingLevel: 'low',
            leafEntryId: 'e3',
            messageCount: 3
        })
        expect(body.sessions[0]).not.toHaveProperty('flavor')
        expect(body.sessions[0]).not.toHaveProperty('launch')
        expect(body.sessions[0]).not.toHaveProperty('extra')
    })

    it('annotates anchored lists with hapiSessionId and import state', async () => {
        const { app, store } = harness()
        const created = store.sessions.getOrCreateSession('tag-1', {
            flavor: 'pi',
            piSessionId: 'pi-1',
            machineId: 'm-1',
            piImportState: { state: 'diverged' }
        }, {}, 'default')
        const response = await app.request('/api/pi/sessions')
        const body = await response.json() as { sessions: Array<Record<string, unknown>> }
        expect(body.sessions[0]).toMatchObject({ hapiSessionId: created.id, importState: 'diverged' })
    })

    it('does not annotate contentPrefix lists with hapiSessionId', async () => {
        const { app, store } = harness()
        store.sessions.getOrCreateSession('tag-codex', {
            flavor: 'codex',
            codexSessionId: 'thread-1',
            machineId: 'm-1'
        }, {}, 'default')
        const response = await app.request('/api/codex/sessions')
        const body = await response.json() as { success: boolean; sessions: Array<Record<string, unknown>> }
        expect(body.success).toBe(true)
        expect(body.sessions[0]).not.toHaveProperty('hapiSessionId')
    })

    it('returns 503 when no machine is online', async () => {
        const { app } = harness({ onlineMachines: [] })
        const response = await app.request('/api/pi/sessions')
        expect(response.status).toBe(503)
    })

    it('returns 503 with the RPC error when the machine fetch fails', async () => {
        const { app } = harness({ rpcError: 'runner exploded' })
        const response = await app.request('/api/pi/sessions')
        const body = await response.json() as { success: boolean; error: string }
        expect(response.status).toBe(503)
        expect(body.error).toBe('runner exploded')
    })

    it('imports through the generic path and preserves the legacy result id key', async () => {
        const { app, store, calls } = harness()
        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['pi-1'] })
        })
        const body = await response.json() as { success: boolean; results: Array<Record<string, unknown>> }
        expect(body.success).toBe(true)
        expect(body.results[0]).toMatchObject({ sessionId: 'pi-1', piSessionId: 'pi-1', action: 'created', appended: 1 })
        const session = store.sessions.getSessionsByNamespace('default')
            .find((candidate) => (candidate.metadata as Record<string, unknown>).flavor === 'pi')
        expect(session).toBeDefined()
        expect(calls[0]).toMatchObject({ method: 'listLocalSessions' })
    })

    it('rejects empty selections and enforces the flavor import limit', async () => {
        const { app } = harness()
        const empty = await app.request('/api/pi/import-sessions', { method: 'POST', body: JSON.stringify({ sessionIds: [] }) })
        expect(empty.status).toBe(400)
        const oversized = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `ses-${index}`) })
        })
        expect(oversized.status).toBe(400)
        // Pi carries the same 200 cap.
        const piOversized = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `pi-${index}`) })
        })
        expect(piOversized.status).toBe(400)
    })

    it('marks a missing transcript as not_found', async () => {
        const { app } = harness()
        const response = await app.request('/api/pi/import-sessions', { method: 'POST', body: JSON.stringify({ sessionIds: ['missing'] }) })
        const body = await response.json() as { results: Array<Record<string, unknown>> }
        expect(body.results[0]).toMatchObject({ sessionId: 'missing', error: { code: 'not_found' } })
    })

    it('stops the codex batch on the first error', async () => {
        const { app } = harness()
        const response = await app.request('/api/codex/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['missing-1', 'missing-2'] })
        })
        const body = await response.json() as { results: Array<Record<string, unknown>> }
        expect(body.results).toHaveLength(1)
        expect(body.results[0]).toMatchObject({ error: { code: 'not_found' } })
    })

    it('applies the requested Claude model, effort and permission mode to the import', async () => {
        const claude: LocalTranscript = {
            flavor: 'claude',
            id: 'claude-1',
            title: 'Claude session',
            lastUserMessage: 'hello',
            cwd: '/tmp/project',
            file: '/tmp/claude-1.jsonl',
            modifiedAt: 1,
            messages: [{
                id: 'claude:u1',
                createdAt: 1,
                content: { role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' } },
                anchor: 'u1'
            }]
        }
        const { app, store, appliedConfigs } = harness({ sources: [CLAUDE_LOCAL_SESSION_SOURCE], summaries: [claude], transcripts: [claude] })
        stores.push(store)
        const response = await app.request('/api/claude/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['claude-1'], model: 'opus', effort: 'high', permissionMode: 'plan' })
        })
        const body = await response.json() as { results: Array<Record<string, unknown>> }
        expect(body.results[0]).toMatchObject({ claudeSessionId: 'claude-1', action: 'created' })
        expect(appliedConfigs).toEqual([{ model: 'opus', effort: 'high', permissionMode: 'plan' }])
    })

    it('enforces the claude import limit with a 400 before any RPC', async () => {
        const { app, calls } = harness({ sources: [CLAUDE_LOCAL_SESSION_SOURCE] })
        const response = await app.request('/api/claude/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `claude-${index}`) })
        })
        expect(response.status).toBe(400)
        const body = await response.json() as { success: boolean; error?: string }
        expect(body.success).toBe(false)
        expect(body.error).toContain('200')
        expect(calls).toHaveLength(0)
    })

    it('lists and imports local Antigravity sessions with permissionMode and model', async () => {
        const agySummary: LocalTranscriptSummary = {
            flavor: 'agy',
            id: 'agy-1',
            title: 'Antigravity session',
            lastUserMessage: 'hello agy',
            cwd: '/tmp/agy-project',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-1/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10
        }
        const agyTranscript: LocalTranscript = {
            ...agySummary,
            messages: [{
                id: 'agy:agy-1:step:0:0',
                createdAt: 10,
                content: { role: 'user', content: { type: 'text', text: 'hello agy' }, meta: { sentFrom: 'cli' } },
                anchor: 'step:0:0'
            }]
        }
        const { app, store, appliedConfigs } = harness({
            sources: [AGY_LOCAL_SESSION_SOURCE],
            summaries: [agySummary],
            transcripts: [agyTranscript]
        })
        stores.push(store)

        const listRes = await app.request('/api/agy/sessions')
        expect(listRes.status).toBe(200)
        const listBody = await listRes.json() as { success: boolean; sessions: Array<Record<string, unknown>> }
        expect(listBody.success).toBe(true)
        expect(listBody.sessions).toHaveLength(1)
        expect(listBody.sessions[0]).toMatchObject({ id: 'agy-1', title: 'Antigravity session' })

        const importRes = await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-1'], model: 'gemini-3-pro', effort: 'high', permissionMode: 'request-review' })
        })
        expect(importRes.status).toBe(200)
        const importBody = await importRes.json() as { success: boolean; results: Array<Record<string, unknown>> }
        expect(importBody.success).toBe(true)
        expect(importBody.results[0]).toMatchObject({ agySessionId: 'agy-1', action: 'created', appended: 1 })
        expect(appliedConfigs).toEqual([{ model: 'gemini-3-pro', effort: 'high', permissionMode: 'request-review' }])

        const secondListRes = await app.request('/api/agy/sessions')
        const secondListBody = await secondListRes.json() as { sessions: Array<Record<string, unknown>> }
        expect(secondListBody.sessions[0]).toMatchObject({ id: 'agy-1', hapiSessionId: importBody.results[0]!.hapiSessionId })
    })

    it('refuses transcript-only Antigravity imports without a working directory instead of saving .system_generated/logs', async () => {
        const agySummary: LocalTranscriptSummary = {
            flavor: 'agy',
            id: 'agy-no-cwd',
            title: 'No workspace session',
            lastUserMessage: 'hi',
            cwd: null,
            file: '/tmp/.gemini/antigravity-cli/brain/agy-no-cwd/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10
        }
        const agyTranscript: LocalTranscript = {
            ...agySummary,
            messages: [{
                id: 'agy:agy-no-cwd:step:0:0',
                createdAt: 10,
                content: { role: 'user', content: { type: 'text', text: 'hi' }, meta: { sentFrom: 'cli' } },
                anchor: 'step:0:0'
            }]
        }
        const { app, store } = harness({
            sources: [AGY_LOCAL_SESSION_SOURCE],
            summaries: [agySummary],
            transcripts: [agyTranscript]
        })
        stores.push(store)

        const res = await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-no-cwd'] })
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { success: boolean; results: Array<{ error?: { code: string } }> }
        expect(body.success).toBe(false)
        expect(body.results[0]?.error?.code).toBe('missing_cwd')
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('appends late action steps onto an already-imported Antigravity session without divergence', async () => {
        const baseSummary: LocalTranscriptSummary = {
            flavor: 'agy',
            id: 'agy-grow',
            title: 'Growing session',
            lastUserMessage: 'run checks',
            cwd: '/tmp/agy-project',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-grow/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10
        }
        const plannerCall0 = {
            id: 'agy:agy-grow:step:1:call:0',
            createdAt: 11,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Read', callId: 'c0', input: { file_path: 'a.ts' }, status: 'completed' } }, meta: { sentFrom: 'cli' } },
            anchor: 'step:1:call:0'
        } as const
        const plannerCall1 = {
            id: 'agy:agy-grow:step:1:call:1',
            createdAt: 11,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Read', callId: 'c1', input: { file_path: 'b.ts' }, status: 'completed' } }, meta: { sentFrom: 'cli' } },
            anchor: 'step:1:call:1'
        } as const
        const initial: LocalTranscript = { ...baseSummary, messages: [plannerCall0, plannerCall1] }
        const grown: LocalTranscript = {
            ...baseSummary,
            messages: [
                plannerCall0,
                plannerCall1,
                {
                    id: 'agy:agy-grow:step:2:0',
                    createdAt: 12,
                    content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'c0', output: 'file A', is_error: false } }, meta: { sentFrom: 'cli' } },
                    anchor: 'step:2:0'
                }
            ]
        }
        let current = initial
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async (_machineId: string, payload: { sessionIds?: string[] | null }) => {
                if (payload.sessionIds) return { success: true, sessions: [current] }
                const { messages: _messages, ...summary } = current
                return { success: true, sessions: [summary] }
            },
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({ store, getSyncEngine: () => engine, sources: [AGY_LOCAL_SESSION_SOURCE] }))

        const first = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-grow'] })
        })).json() as { results: Array<Record<string, unknown>> }
        expect(first.results[0]).toMatchObject({ action: 'created', appended: 2 })

        current = grown
        const second = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-grow'] })
        })).json() as { results: Array<Record<string, unknown>> }
        expect(second.results[0]).toMatchObject({ agySessionId: 'agy-grow', action: 'updated', appended: 1 })
    })

    it('uses body cwd on first import of a transcript-only Antigravity session and preserves it on re-import from another directory', async () => {
        const initial: LocalTranscript = {
            flavor: 'agy',
            id: 'agy-no-cwd',
            title: 'Transcript-only session',
            lastUserMessage: 'first prompt',
            cwd: null,
            file: '/tmp/.gemini/antigravity-cli/brain/agy-no-cwd/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10,
            messages: [
                { id: 'agy:agy-no-cwd:step:0:0', createdAt: 10, content: { role: 'user', content: { type: 'text', text: 'first prompt' }, meta: { sentFrom: 'cli' } }, anchor: 'step:0:0' }
            ]
        }
        const grown: LocalTranscript = {
            ...initial,
            lastUserMessage: 'second prompt',
            modifiedAt: 20,
            messages: [
                ...initial.messages,
                { id: 'agy:agy-no-cwd:step:1:0', createdAt: 20, content: { role: 'user', content: { type: 'text', text: 'second prompt' }, meta: { sentFrom: 'cli' } }, anchor: 'step:1:0' }
            ]
        }
        let current = initial
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async (_machineId: string, payload: { sessionIds?: string[] | null }) => {
                if (payload.sessionIds) return { success: true, sessions: [current] }
                const { messages: _messages, ...summary } = current
                return { success: true, sessions: [summary] }
            },
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({ store, getSyncEngine: () => engine, sources: [AGY_LOCAL_SESSION_SOURCE] }))

        const first = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-no-cwd'], cwd: '/proj-a' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string }> }
        expect(first.results[0]).toMatchObject({ action: 'created' })
        const sessionId = first.results[0]!.hapiSessionId!
        expect((store.sessions.getSessionByNamespace(sessionId, 'default')?.metadata as { path?: string }).path).toBe('/proj-a')

        current = grown
        const second = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-no-cwd'], cwd: '/proj-b' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string; appended?: number }> }
        expect(second.results[0]).toMatchObject({ hapiSessionId: sessionId, action: 'updated', appended: 1 })
        expect((store.sessions.getSessionByNamespace(sessionId, 'default')?.metadata as { path?: string }).path).toBe('/proj-a')

        const listed = await (await app.request('/api/agy/sessions')).json() as {
            sessions: Array<{ id: string; cwd: string | null; savedCwd?: string; hapiSessionId?: string }>
        }
        expect(listed.sessions[0]).toMatchObject({
            id: 'agy-no-cwd',
            cwd: null,
            savedCwd: '/proj-a',
            hapiSessionId: sessionId
        })
    })

    it('keeps a mixed Antigravity batch going when one transcript is still flushing, reconciles live HAPI turns on re-import, and does not apply fallbackCwd to Claude', async () => {
        const makeAgyTranscript = (id: string): LocalTranscript => ({
            flavor: 'agy',
            id,
            title: `Antigravity ${id}`,
            lastUserMessage: 'first prompt',
            cwd: '/work',
            file: `/tmp/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`,
            modifiedAt: 10,
            messages: [
                {
                    id: `agy:${id}:step:0:user`,
                    createdAt: 10,
                    content: { role: 'user', content: { type: 'text', text: 'first prompt' }, meta: { sentFrom: 'cli' } },
                    anchor: 'step:0:user'
                }
            ]
        })
        const flushing: LocalTranscript = {
            ...makeAgyTranscript('agy-flushing'),
            messages: [],
            extra: { importError: 'Antigravity full transcript is still flushing; please retry import shortly' }
        }
        let agyContinued: LocalTranscript = makeAgyTranscript('agy-continued')
        const claudeNullCwd: LocalTranscript = {
            flavor: 'claude',
            id: 'claude-null-cwd',
            title: 'Claude without cwd',
            lastUserMessage: 'hello claude',
            cwd: null,
            file: '/claude-projects/my-proj/claude-null-cwd.jsonl',
            modifiedAt: 10,
            messages: [
                {
                    id: 'claude:uuid-1',
                    createdAt: 10,
                    content: { role: 'user', content: { type: 'text', text: 'hello claude' }, meta: { sentFrom: 'cli' } }
                }
            ]
        }
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async (_machineId: string, payload: { flavor: string }) => ({
                success: true,
                sessions: payload.flavor === 'claude' ? [claudeNullCwd] : [flushing, agyContinued]
            }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE, CLAUDE_LOCAL_SESSION_SOURCE]
        }))

        const batchRes = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-flushing', 'agy-continued'], cwd: '/work' })
        })).json() as {
            success: boolean
            results: Array<{ agySessionId: string; hapiSessionId?: string; action?: string; error?: { code: string; message: string } }>
        }
        expect(batchRes.success).toBe(false)
        expect(batchRes.results).toEqual([
            expect.objectContaining({
                agySessionId: 'agy-flushing',
                error: {
                    code: 'transcript_flushing',
                    message: 'Antigravity full transcript is still flushing; please retry import shortly'
                }
            }),
            expect.objectContaining({
                agySessionId: 'agy-continued',
                action: 'created'
            })
        ])
        const hapiId = batchRes.results[1]!.hapiSessionId!

        // Simulate a live turn sent in HAPI on the imported session (stored without agy: localIds).
        store.messages.addMessage(
            hapiId,
            { role: 'user', content: { type: 'text', text: 'live follow-up from HAPI' }, meta: { sentFrom: 'web' } },
            'web-live-uuid-1'
        )
        store.messages.addMessage(
            hapiId,
            {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'Live answer from agy' } },
                meta: { sentFrom: 'cli' }
            },
            undefined
        )
        store.messages.addMessage(
            hapiId,
            {
                role: 'agent',
                content: { type: 'event', data: { type: 'round-summary', summary: { provider: 'agy' } } },
                meta: { sentFrom: 'cli' }
            },
            undefined
        )

        // Native transcript now includes that live turn plus a subsequent external CLI turn.
        agyContinued = {
            ...agyContinued,
            messages: [
                ...agyContinued.messages,
                {
                    id: 'agy:agy-continued:step:2:user',
                    createdAt: 20,
                    content: { role: 'user', content: { type: 'text', text: 'live follow-up from HAPI' }, meta: { sentFrom: 'cli' } },
                    anchor: 'step:2:user'
                },
                {
                    id: 'agy:agy-continued:step:3:text',
                    createdAt: 21,
                    content: {
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'Live answer from agy' } },
                        meta: { sentFrom: 'cli' }
                    },
                    anchor: 'step:3:text'
                }
            ]
        }

        const reimportSame = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-continued'], cwd: '/work' })
        })).json() as { success: boolean; results: Array<{ hapiSessionId?: string; action?: string; appended?: number }> }
        expect(reimportSame.success).toBe(true)
        expect(reimportSame.results[0]).toMatchObject({
            hapiSessionId: hapiId,
            action: 'unchanged',
            appended: 0
        })

        // External CLI appends one more turn after the HAPI turn.
        agyContinued = {
            ...agyContinued,
            messages: [
                ...agyContinued.messages,
                {
                    id: 'agy:agy-continued:step:4:user',
                    createdAt: 30,
                    content: { role: 'user', content: { type: 'text', text: 'external cli turn' }, meta: { sentFrom: 'cli' } },
                    anchor: 'step:4:user'
                }
            ]
        }
        const reimportAfterExternal = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-continued'], cwd: '/work' })
        })).json() as { success: boolean; results: Array<{ hapiSessionId?: string; action?: string; appended?: number }> }
        expect(reimportAfterExternal.success).toBe(true)
        expect(reimportAfterExternal.results[0]).toMatchObject({
            hapiSessionId: hapiId,
            action: 'updated',
            appended: 1
        })

        // Claude with cwd: null keeps dirname(transcript.file) instead of request fallbackCwd.
        const claudeRes = await (await app.request('/api/claude/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['claude-null-cwd'], cwd: '/form-unrelated-dir' })
        })).json() as { success: boolean; results: Array<{ hapiSessionId?: string }> }
        expect(claudeRes.success).toBe(true)
        const claudeHapiId = claudeRes.results[0]!.hapiSessionId!
        expect((store.sessions.getSessionByNamespace(claudeHapiId, 'default')?.metadata as { path?: string }).path)
            .toBe('/claude-projects/my-proj')
    })

    it('keeps imported Antigravity sessions with the same native ID distinct across two machines', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const m1 = machine('m-1')
        const m2 = machine('m-2')
        const engine = {
            getOnlineMachinesByNamespace: () => [m1, m2],
            listLocalSessionsForMachine: async (machineId: string) => ({
                success: true,
                sessions: [{
                    flavor: 'agy' as const,
                    id: 'agy-shared-conv',
                    title: 'Shared conv',
                    lastUserMessage: `from ${machineId}`,
                    cwd: '/work',
                    file: '/tmp/.gemini/antigravity-cli/brain/agy-shared-conv/.system_generated/logs/transcript.jsonl',
                    modifiedAt: 10,
                    messages: [{
                        id: 'agy:agy-shared-conv:step:0:user',
                        createdAt: 10,
                        content: { role: 'user', content: { type: 'text', text: `from ${machineId}` }, meta: { sentFrom: 'cli' } },
                        anchor: 'step:0:user'
                    }]
                }]
            }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE]
        }))

        const importM1 = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-shared-conv'], machineId: 'm-1', cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string }> }
        const importM2 = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-shared-conv'], machineId: 'm-2', cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string }> }

        const hapiM1 = importM1.results[0]!.hapiSessionId!
        const hapiM2 = importM2.results[0]!.hapiSessionId!
        expect(hapiM1).not.toBe(hapiM2)
        expect(store.messages.getAllMessages(hapiM1)[0]?.content).toMatchObject({
            content: { text: 'from m-1' }
        })
        expect(store.messages.getAllMessages(hapiM2)[0]?.content).toMatchObject({
            content: { text: 'from m-2' }
        })
    })

})

describe('fetchLocalTranscripts', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('uses the registry RPC when the machine advertises the capability', async () => {
        const calls: Array<{ method: string; payload: unknown }> = []
        const engine = {
            listLocalSessionsForMachine: async (_machineId: string, payload: unknown) => {
                calls.push({ method: 'listLocalSessions', payload })
                return { success: true, sessions: [piSummary()] }
            }
        } as unknown as SyncEngine
        const result = await fetchLocalTranscriptSummaries({
            source: PI_LOCAL_SESSION_SOURCE,
            engine,
            machine: machine()
        })
        expect(result.success).toBe(true)
        expect(calls[0]).toMatchObject({ method: 'listLocalSessions' })
    })

    it('falls back to the legacy RPC and converts raw rows without the capability', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const legacyCalls: unknown[] = []
        const engine = {
            listPiSessionsForMachine: async () => {
                legacyCalls.push('legacy')
                return { success: true, sessions: [piSummary()] }
            }
        } as unknown as SyncEngine
        const result = await fetchLocalTranscriptSummaries({
            source: PI_LOCAL_SESSION_SOURCE,
            engine,
            machine: machine('m-1', [])
        })
        expect(legacyCalls).toEqual(['legacy'])
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.sessions[0]).toMatchObject({ flavor: 'pi', id: 'pi-1' })
        }
    })

    it('fails closed when neither the capability nor a legacy fetch exists', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const source = { ...OPENCODE_LOCAL_SESSION_SOURCE, legacy: undefined }
        const result = await fetchLocalTranscriptSummaries({
            source,
            engine: { listOpencodeSessionsForMachine: async () => ({ success: true, sessions: [] }) } as unknown as SyncEngine,
            machine: machine('m-1', [])
        })
        expect(result.success).toBe(false)
    })

    it('returns transcripts for requested ids', async () => {
        const calls: Array<{ method: string; payload: unknown }> = []
        const engine = {
            listLocalSessionsForMachine: async (_machineId: string, payload: unknown) => {
                calls.push({ method: 'listLocalSessions', payload })
                return { success: true, sessions: [piTranscript()] }
            }
        } as unknown as SyncEngine
        const result = await fetchLocalTranscriptsByIds({
            source: PI_LOCAL_SESSION_SOURCE,
            engine,
            machine: machine(),
            sessionIds: ['pi-1']
        })
        expect(result.success).toBe(true)
        expect(calls[0]).toMatchObject({ method: 'listLocalSessions', payload: { flavor: 'pi', sessionIds: ['pi-1'] } })
        if (result.success) {
            expect('messages' in result.sessions[0]).toBe(true)
        }
    })
})