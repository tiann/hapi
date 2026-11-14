import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import type { WebAppEnv } from '../../middleware/auth'
import { Store } from '../../../store'
import { CLAUDE_LOCAL_SESSION_SOURCE, CODEX_LOCAL_SESSION_SOURCE, OPENCODE_LOCAL_SESSION_SOURCE, PI_LOCAL_SESSION_SOURCE } from './sources'
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