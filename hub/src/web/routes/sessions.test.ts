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

function createApp(session: Session) {
    const applySessionConfigCalls: Array<[string, Record<string, unknown>]> = []
    const applySessionConfig = async (sessionId: string, config: Record<string, unknown>) => {
        applySessionConfigCalls.push([sessionId, config])
    }
    const resumeSessionCalls: Array<[string, string, Parameters<SyncEngine['resumeSession']>[2]]> = []
    const resumeSession = async (sessionId: string, namespace: string, opts?: Parameters<SyncEngine['resumeSession']>[2]) => {
        resumeSessionCalls.push([sessionId, namespace, opts])
        return { type: 'success' as const, sessionId }
    }
    const listCodexModelsForSession = async () => ({
        success: true,
        models: [
            { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }
        ]
    })
    const engine = {
        resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
        applySessionConfig,
        resumeSession,
        listCodexModelsForSession
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine as SyncEngine))

    return { app, applySessionConfigCalls, resumeSessionCalls }
}

describe('sessions routes', () => {
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

    it('applies model changes for remote Codex sessions', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.5' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'gpt-5.5' }]
        ])
    })

    it('rejects model changes for local Codex sessions', async () => {
        const session = createSession({
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {}
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.5' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Model selection can only be changed for remote Codex sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
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
            error: 'Effort selection is only supported for Claude sessions'
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

    it('returns Codex models for active Codex sessions', async () => {
        const { app } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/codex-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            models: [
                { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }
            ]
        })
    })

    it('rejects resume with bypassPermissions for Codex sessions (flavor validation)', async () => {
        const session = createSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' }
        })
        const { app, resumeSessionCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionMode: 'bypassPermissions' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: expect.stringContaining('permission mode') })
        expect(resumeSessionCalls).toHaveLength(0)
    })

    it('allows resume with a valid Codex permissionMode', async () => {
        const session = createSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' }
        })
        const { app, resumeSessionCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionMode: 'yolo' })
        })

        expect(response.status).toBe(200)
        expect(resumeSessionCalls).toHaveLength(1)
        expect(resumeSessionCalls[0][2]).toEqual({ permissionMode: 'yolo' })
    })

    it('forwards permissionMode from resume body to engine.resumeSession', async () => {
        const session = createSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'claude' }
        })
        const { app, resumeSessionCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionMode: 'bypassPermissions' })
        })

        expect(response.status).toBe(200)
        expect(resumeSessionCalls).toHaveLength(1)
        expect(resumeSessionCalls[0][2]).toEqual({ permissionMode: 'bypassPermissions' })
    })

    it('accepts resume requests without a body (backward compatible)', async () => {
        const session = createSession({ active: false })
        const { app, resumeSessionCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST'
        })

        expect(response.status).toBe(200)
        expect(resumeSessionCalls).toHaveLength(1)
        expect(resumeSessionCalls[0][2]).toBeUndefined()
    })

    it('returns 400 when resume body is present but invalid', async () => {
        const session = createSession({ active: false })
        const { app, resumeSessionCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionMode: 'not-a-valid-mode' })
        })

        expect(response.status).toBe(400)
        expect(resumeSessionCalls).toHaveLength(0)
    })

    it('accepts permission-mode changes for inactive sessions and updates cache', async () => {
        const session = createSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'claude' }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/permission-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'bypassPermissions' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { permissionMode: 'bypassPermissions' }]
        ])
    })
})
