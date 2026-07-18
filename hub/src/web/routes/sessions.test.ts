import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function createSession(overrides?: Partial<Session>): Session {
    const baseMetadata = {
        path: '/tmp/project',
        host: 'localhost',
        flavor: 'codex' as const
    }
    const base: Session = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: baseMetadata,
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: {},
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: 'gpt-5.4',
        modelReasoningEffort: null,
        effort: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    }

    return {
        ...base,
        ...overrides,
        metadata: overrides?.metadata === undefined
            ? base.metadata
            : overrides.metadata === null
                ? null
                : {
                    ...baseMetadata,
                    ...overrides.metadata
                },
        agentState: overrides?.agentState === undefined ? base.agentState : overrides.agentState
    }
}

function createApp(session: Session, options: { abortError?: Error } = {}) {
    const applySessionConfigCalls: Array<[string, Record<string, unknown>]> = []
    const readCalls: Array<[string, string]> = []
    const listSkillsCalls: Array<[string, string]> = []
    const listMentionsCalls: Array<[string, string]> = []
    const abortCalls: string[] = []
    const applySessionConfig = async (sessionId: string, config: Record<string, unknown>) => {
        applySessionConfigCalls.push([sessionId, config])
    }
    const engine = {
        getSessionsByNamespace: () => [session],
        getSessionUnreadCounts: () => new Map([[session.id, 3]]),
        resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
        abortSession: async (sessionId: string) => {
            abortCalls.push(sessionId)
            if (options.abortError) throw options.abortError
        },
        applySessionConfig,
        markSessionRead: (sessionId: string, namespace: string) => {
            readCalls.push([sessionId, namespace])
        },
        listSkills: async (sessionId: string, agent: string) => {
            listSkillsCalls.push([sessionId, agent])
            return { success: true, skills: [] }
        },
        listMentions: async (machineId: string, agent: string) => {
            listMentionsCalls.push([machineId, agent])
            return { success: true, mentions: [] }
        }
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine as SyncEngine))

    return { app, applySessionConfigCalls, readCalls, listSkillsCalls, listMentionsCalls, abortCalls }
}

describe('sessions routes', () => {
    it('returns a server error instead of success when abort RPC fails', async () => {
        const { app, abortCalls } = createApp(createSession(), {
            abortError: new Error('failed to durably canceled queued messages')
        })

        const response = await app.request('/api/sessions/session-1/abort', { method: 'POST' })

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({
            ok: false,
            error: 'failed to durably canceled queued messages'
        })
        expect(abortCalls).toEqual(['session-1'])
    })

    it('includes notification unread count in session summaries', async () => {
        const { app } = createApp(createSession())

        const response = await app.request('/api/sessions')

        expect(response.status).toBe(200)
        const json = await response.json() as { sessions: Array<{ id: string; unreadCount: number }> }
        expect(json.sessions).toHaveLength(1)
        expect(json.sessions[0]).toMatchObject({ id: 'session-1', unreadCount: 3 })
    })

    it('marks notification unread count read for a session', async () => {
        const { app, readCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/read', { method: 'POST' })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(readCalls).toEqual([['session-1', 'default']])
    })

    it('passes session flavor when listing skills', async () => {
        const { app, listSkillsCalls } = createApp(createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex'
            }
        }))

        const response = await app.request('/api/sessions/session-1/skills')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true, skills: [] })
        expect(listSkillsCalls).toEqual([['session-1', 'codex']])
    })

    it('defaults to claude when listing skills for a session without flavor metadata', async () => {
        const { app, listSkillsCalls } = createApp(createSession({ metadata: null }))

        const response = await app.request('/api/sessions/session-1/skills')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true, skills: [] })
        expect(listSkillsCalls).toEqual([['session-1', 'claude']])
    })

    it('passes machine and session flavor when listing mentions', async () => {
        const { app, listMentionsCalls } = createApp(createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                machineId: 'machine-1'
            }
        }))

        const response = await app.request('/api/sessions/session-1/mentions')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true, mentions: [] })
        expect(listMentionsCalls).toEqual([['machine-1', 'codex']])
    })

    it('returns a structured error when listing mentions without a machine id', async () => {
        const { app, listMentionsCalls } = createApp(createSession({ metadata: null }))

        const response = await app.request('/api/sessions/session-1/mentions')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: false, error: 'Session missing machine ID' })
        expect(listMentionsCalls).toEqual([])
    })

    it('applies model changes for Codex GPT-5.6 sessions', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.6-sol' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'gpt-5.6-sol' }]
        ])
    })

    it('clears stale Codex reasoning effort when the selected model does not support it', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession({
            model: 'gpt-5.6-sol',
            modelReasoningEffort: 'ultra'
        }))

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.6-luna' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'gpt-5.6-luna', modelReasoningEffort: null }]
        ])
    })

    it('applies model changes for Antigravity agy sessions when the model is in the live preset list', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'agy'
            },
            model: 'Gemini 3.5 Flash (High)'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'Gemini 3 Flash' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'Gemini 3 Flash' }]
        ])
    })

    it('rejects unsupported Antigravity agy model changes', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'agy'
            },
            model: 'Gemini 3.5 Flash (High)'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'not-a-live-agy-model' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Unknown Antigravity agy model: not-a-live-agy-model' })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies model changes for Hermes MoA sessions when the GPT-5.6 Sol preset is supported', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'hermes-moa'
            },
            model: 'default'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.6-sol-max' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'gpt-5.6-sol-max' }]
        ])
    })

    it('rejects unsupported Hermes MoA preset changes', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'hermes-moa'
            },
            model: 'default'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'not-a-moa-preset' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Unknown Hermes MoA preset: not-a-moa-preset' })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('rejects clearing the model for Hermes MoA sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'hermes-moa'
            },
            model: 'fable-5-1m-max'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: null })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Hermes MoA preset is required' })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies model changes for CC-ark sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude-ark'
            },
            model: 'doubao-seed-2.0-code'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-v4-pro' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'deepseek-v4-pro' }]
        ])
    })

    it('applies model changes for CC-deepseek sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude-deepseek'
            },
            model: 'deepseek-v4-pro[1m]',
            effort: 'max'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-v4-flash' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'deepseek-v4-flash' }]
        ])
    })

    it('clears stale unsupported CC-api effort when switching to an Auto-only model', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cc-api'
            },
            model: 'glm-5.2',
            effort: 'max'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'kimi-k2.7-code' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'kimi-k2.7-code', effort: null }]
        ])
    })

    it('rejects unlisted CC-api model changes on an active session', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cc-api'
            },
            model: 'kimi-k3',
            effort: 'max'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'custom-cc-api-model' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Unknown CC-api model: custom-cc-api-model' })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('rejects collaboration mode changes for local Codex sessions', async () => {
        const session = createSession({
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {}
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/collaboration-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'plan' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Collaboration mode can only be changed for remote Codex sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('rejects permission mode changes for locally controlled sessions', async () => {
        const session = createSession({
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {}
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/permission-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'read-only' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Permission mode can only be changed for remote sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('rejects collaboration mode changes for non-Codex sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/collaboration-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'plan' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Collaboration mode is only supported for Codex sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies collaboration mode changes for remote Codex sessions', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/collaboration-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'plan' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { collaborationMode: 'plan' }]
        ])
    })

    it('rejects model reasoning effort changes for non-Codex sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model-reasoning-effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelReasoningEffort: 'high' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Model reasoning effort is only supported for Codex sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('rejects model reasoning effort changes for local Codex sessions', async () => {
        const session = createSession({
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {}
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model-reasoning-effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelReasoningEffort: 'high' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Model reasoning effort can only be changed for remote Codex sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies model reasoning effort changes for remote Codex sessions', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/model-reasoning-effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelReasoningEffort: 'xhigh' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { modelReasoningEffort: 'xhigh' }]
        ])
    })

    it('rejects service tier changes for non-Codex sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/service-tier', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceTier: 'fast' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Service tier is only supported for Codex sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('rejects service tier changes for local Codex sessions', async () => {
        const session = createSession({
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {}
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/service-tier', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceTier: 'fast' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Service tier can only be changed for remote Codex sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies service tier changes for remote Codex sessions', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/service-tier', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceTier: 'fast' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { serviceTier: 'fast' }]
        ])
    })

    it('rejects effort changes for non-Claude sessions', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'high' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Effort selection is not supported for this session flavor'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies effort changes for Claude sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'max' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { effort: 'max' }]
        ])
    })

    it('applies effort changes for claude-deepseek sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude-deepseek'
            },
            model: 'deepseek-v4-flash'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'high' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { effort: 'high' }]
        ])
    })

    it('rejects unsupported effort changes for claude-deepseek sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude-deepseek'
            },
            model: 'deepseek-v4-flash'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'medium' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Effort selection is not supported for the current CC-deepseek model' })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies effort changes for CC-ark sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude-ark'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'high' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { effort: 'high' }]
        ])
    })

    it('applies model-aware effort changes for CC-api sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cc-api'
            },
            model: 'glm-5.2'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'max' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { effort: 'max' }]
        ])
    })

    it('rejects unsupported CC-api effort for the current model', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cc-api'
            },
            model: 'kimi-k2.7-code'
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'high' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Effort selection is not supported for the current CC-api model' })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('takes over an active desktop mirror session when it is idle', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                codexSessionId: 'thread-1',
                executionControl: {
                    owner: 'desktop-sync',
                    generation: 1,
                    leaseExpiresAt: null,
                    runnerSessionId: null,
                    updatedAt: 1
                }
            },
            active: true,
            thinking: false
        })
        const takeoverCalls: string[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
            takeoverSession: async (sessionId: string) => {
                takeoverCalls.push(sessionId)
                return { type: 'success', sessionId: 'session-runner' as const }
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/sessions/session-1/takeover', { method: 'POST' })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-runner' })
        expect(takeoverCalls).toEqual(['session-1'])
    })

    it('returns 409 when desktop mirror takeover is attempted while the desktop turn is still running', async () => {
        const session = createSession({ thinking: true })
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
            takeoverSession: async () => ({ type: 'error', code: 'takeover_busy' as const, message: 'Desktop session is still running' })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/sessions/session-1/takeover', { method: 'POST' })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Desktop session is still running', code: 'takeover_busy' })
    })

})
