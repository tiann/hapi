import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createDshRoutes } from './dsh'

function createSession(overrides?: Partial<Session>): Session {
    const baseMetadata = {
        path: '/tmp/project',
        host: 'localhost',
        flavor: 'dsh' as const,
        dshSessionId: 'dsh-native-1'
    }
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: baseMetadata,
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: undefined,
        collaborationMode: undefined,
        ...overrides
    } as Session
}

type EngineOverrides = Partial<{
    dshAction: SyncEngine['dshAction']
    dshModels: SyncEngine['dshModels']
    dshSkills: SyncEngine['dshSkills']
    sessionAccess: 'ok' | 'not-found' | 'wrong-namespace'
    callerNamespace: string
}>

function createApp(session: Session, overrides: EngineOverrides = {}) {
    const dshAction = mock(overrides.dshAction ?? (async () => ({ accepted: true })))
    const dshModels = mock(overrides.dshModels ?? (async () => ({
        current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        routable: true,
        groups: [],
        failures: []
    })))
    const dshSkills = mock(overrides.dshSkills ?? (async () => ({ skills: [] })))

    const engine = {
        resolveSessionAccess: () => {
            if (overrides.sessionAccess === 'not-found') {
                return { ok: false, reason: 'not-found' as const }
            }
            if (overrides.sessionAccess === 'wrong-namespace') {
                return { ok: false, reason: 'access-denied' as const }
            }
            return { ok: true, sessionId: session.id, session }
        },
        dshAction,
        dshModels,
        dshSkills
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', overrides.callerNamespace ?? 'default')
        await next()
    })
    app.route('/api', createDshRoutes(() => engine))
    return { app, dshAction, dshModels, dshSkills }
}

describe('DSH session routes', () => {
    it('routes a validated action to the session-scoped RPC', async () => {
        const session = createSession()
        const { app, dshAction } = createApp(session)
        const response = await app.request('/api/sessions/session-1/dsh/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'prompt',
                mode: 'queue',
                text: 'hello dsh'
            })
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, result: { accepted: true } })
        expect(dshAction).toHaveBeenCalledWith('session-1', {
            type: 'prompt',
            mode: 'queue',
            text: 'hello dsh'
        })
    })

    it('rejects non-dsh sessions', async () => {
        const session = createSession({ metadata: { path: '/tmp/p', host: 'h', flavor: 'claude' } })
        const { app, dshAction } = createApp(session)
        const response = await app.request('/api/sessions/session-1/dsh/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'interrupt' })
        })
        expect(response.status).toBe(400)
        expect(dshAction).not.toHaveBeenCalled()
    })

    it('rejects malformed action payloads with 400 before any RPC', async () => {
        const session = createSession()
        const { app, dshAction } = createApp(session)
        const response = await app.request('/api/sessions/session-1/dsh/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'not-an-action' })
        })
        expect(response.status).toBe(400)
        expect(dshAction).not.toHaveBeenCalled()
    })

    it('rejects unknown sessions and wrong namespaces', async () => {
        const session = createSession()
        const { app } = createApp(session, { sessionAccess: 'not-found' })
        expect((await app.request('/api/sessions/session-1/dsh/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'interrupt' })
        })).status).toBe(404)

        const { app: app2 } = createApp(session, { sessionAccess: 'wrong-namespace' })
        expect((await app2.request('/api/sessions/session-1/dsh/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'interrupt' })
        })).status).toBe(403)
    })

    it('serves the runtime-discovered model catalog', async () => {
        const session = createSession()
        const { app, dshModels } = createApp(session, {
            dshModels: async () => ({
                current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
                routable: true,
                groups: [{
                    id: 'deepseek-official',
                    name: 'DeepSeek',
                    models: [{
                        id: 'deepseek-v4-flash',
                        name: 'DeepSeek V4 Flash',
                        efforts: [{ id: 'high', name: 'High' }],
                        defaultEffort: 'high'
                    }]
                }],
                failures: []
            })
        })
        const response = await app.request('/api/sessions/session-1/dsh/models', { method: 'POST' })
        expect(response.status).toBe(200)
        const body = await response.json() as { current: { provider: string; model: string; reasoningEffort?: string }; groups: Array<{ models: Array<{ efforts?: Array<{ id: string; name: string }> }> }> }
        expect(body.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
        expect(body.groups[0].models[0].efforts).toEqual([{ id: 'high', name: 'High' }])
        expect(dshModels).toHaveBeenCalledWith('session-1')
    })

    it('serves the skill catalog', async () => {
        const session = createSession()
        const { app, dshSkills } = createApp(session, {
            dshSkills: async () => ({
                skills: [{ name: 'frontend', description: 'Frontend work', modelInvocable: true }]
            })
        })
        const response = await app.request('/api/sessions/session-1/dsh/skills', { method: 'POST' })
        expect(response.status).toBe(200)
        const body = await response.json() as { skills: Array<{ name: string; description: string; modelInvocable: boolean }> }
        expect(body.skills).toEqual([{ name: 'frontend', description: 'Frontend work', modelInvocable: true }])
        expect(dshSkills).toHaveBeenCalledWith('session-1')
    })

    it('reports RPC failures as 502', async () => {
        const session = createSession()
        const { app } = createApp(session, {
            dshAction: async () => {
                throw new Error('CLI unreachable')
            }
        })
        const response = await app.request('/api/sessions/session-1/dsh/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'interrupt' })
        })
        expect(response.status).toBe(502)
        expect((await response.json() as { error: string }).error).toContain('CLI unreachable')
    })
})
