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

type ReopenResultMock =
    | { type: 'success'; sessionId: string; resumed: boolean; cursorSessionProtocol?: 'acp' | 'stream-json' }
    | { type: 'error'; message: string; code: string }
    | { type: 'incomplete'; message: string; missing: [string, ...string[]] }

function createApp(session: Session, opts?: {
    resumeSession?: (sessionId: string, namespace: string, resumeOpts?: { permissionMode?: string }) => Promise<{ type: string; sessionId?: string; message?: string; code?: string }>
    reopenSession?: (sessionId: string, namespace: string) => Promise<ReopenResultMock>
    listSlashCommands?: SyncEngine['listSlashCommands']
    getSessionExport?: (sessionId: string, session: Session) => unknown
    sessionExists?: boolean
}) {
    const applySessionConfigCalls: Array<[string, Record<string, unknown>]> = []
    const applySessionConfig = async (sessionId: string, config: Record<string, unknown>) => {
        applySessionConfigCalls.push([sessionId, config])
    }
    const listCodexModelsForSession = async () => ({
        success: true,
        models: [
            { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }
        ]
    })
    const listOpencodeModelsForSession = async () => ({
        success: true,
        availableModels: [
            { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama (SER8)/EXAONE 4.5 33B Q8' },
            { modelId: 'mlx/qwen3:0.6b', name: 'MLX/Qwen3 0.6B' }
        ],
        currentModelId: 'ollama/exaone:4.5-33b-q8'
    })
    const listOpencodeReasoningEffortOptionsForSession = async () => ({
        success: true,
        options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
        ],
        currentValue: 'low'
    })
    const listCursorModelsForSession = async () => ({
        success: true,
        availableModels: [
            { modelId: 'composer-2.5', name: 'Composer 2.5' },
            { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' }
        ],
        currentModelId: 'composer-2.5'
    })
    const resumeSession = opts?.resumeSession ?? (async (sessionId: string) => ({ type: 'success', sessionId }))
    const reopenSession = opts?.reopenSession ?? (async (sessionId: string) => ({
        type: 'success' as const,
        sessionId,
        resumed: true
    }))
    const sessionExists = opts?.sessionExists !== false
    const engine = {
        resolveSessionAccess: () => sessionExists
            ? { ok: true, sessionId: session.id, session }
            : { ok: false, reason: 'not-found' },
        applySessionConfig,
        listCodexModelsForSession,
        listCursorModelsForSession,
        listOpencodeModelsForSession,
        listOpencodeReasoningEffortOptionsForSession,
        resumeSession,
        reopenSession,
        getSessionExport: opts?.getSessionExport ?? (() => ({
            type: 'success',
            payload: {
                schemaVersion: 1,
                exportedAt: 1_762_000_000_000,
                session,
                messages: []
            }
        })),
        listSlashCommands: opts?.listSlashCommands ?? (async () => ({
            success: true,
            commands: []
        }))
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine as SyncEngine))

    return { app, applySessionConfigCalls }
}

describe('sessions routes', () => {
    it('exports an empty session conversation payload', async () => {
        const session = createSession()
        const { app } = createApp(session)

        const response = await app.request('/api/sessions/session-1/export')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            schemaVersion: 1,
            exportedAt: 1_762_000_000_000,
            session,
            messages: []
        })
    })

    it('exports visible messages in chronological order', async () => {
        const session = createSession()
        const messages = [
            {
                id: 'msg-1',
                seq: 1,
                localId: null,
                content: { role: 'user', content: 'Hello' },
                createdAt: 1000,
                invokedAt: 1001,
                scheduledAt: null
            },
            {
                id: 'msg-2',
                seq: 2,
                localId: null,
                content: { role: 'agent', content: 'Hi there' },
                createdAt: 1002,
                invokedAt: 1002,
                scheduledAt: null
            }
        ]
        const { app } = createApp(session, {
            getSessionExport: () => ({
                type: 'success',
                payload: {
                    schemaVersion: 1,
                    exportedAt: 1_762_000_000_000,
                    session,
                    messages
                }
            })
        })

        const response = await app.request('/api/sessions/session-1/export')

        expect(response.status).toBe(200)
        const body = await response.json() as { messages: Array<{ id: string }> }
        expect(body.messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2'])
    })

    it('returns 413 when the export exceeds the hard message cap', async () => {
        const session = createSession()
        const { app } = createApp(session, {
            getSessionExport: () => ({
                type: 'too-large',
                count: 20_001,
                limit: 20_000
            })
        })

        const response = await app.request('/api/sessions/session-1/export')

        expect(response.status).toBe(413)
        expect(await response.json()).toEqual({
            error: 'Session export too large',
            count: 20_001,
            limit: 20_000
        })
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

    it('rejects model reasoning effort changes for unsupported sessions', async () => {
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
            error: 'Model reasoning effort is only supported for Codex and OpenCode sessions'
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
            error: 'Model reasoning effort can only be changed for remote sessions'
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



    it('applies model reasoning effort changes for remote OpenCode sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'opencode'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model-reasoning-effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelReasoningEffort: 'high' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { modelReasoningEffort: 'high' }]
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

    it('applies model changes for OpenCode sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'opencode'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'ollama/exaone:4.5-33b-q8' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'ollama/exaone:4.5-33b-q8' }]
        ])
    })

    it('applies model changes for Gemini sessions (regression: opencode addition does not break Gemini)', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'gemini'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gemini-2.5-pro' })
        })

        expect(response.status).toBe(200)
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'gemini-2.5-pro' }]
        ])
    })

    it('applies model changes for Cursor sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor'
            }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'sonnet' })
        })

        expect(response.status).toBe(200)
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'sonnet' }]
        ])
    })

    it('rejects model changes for local Cursor sessions', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor'
            },
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
            body: JSON.stringify({ model: 'composer-2.5[fast=true]' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Model selection can only be changed for remote Cursor sessions'
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
            error: 'Effort selection is not supported for this session type'
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

    it('returns OpenCode reasoning effort options for active OpenCode sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'opencode' }
        })
        const { app } = createApp(session)

        const response = await app.request('/api/sessions/session-1/opencode-reasoning-effort-options')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' }
            ],
            currentValue: 'low'
        })
    })

    it('rejects opencode-reasoning-effort-options for non-OpenCode sessions', async () => {
        const { app } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/opencode-reasoning-effort-options')

        expect(response.status).toBe(400)
    })

    it('returns OpenCode models for active OpenCode sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'opencode' }
        })
        const { app } = createApp(session)

        const response = await app.request('/api/sessions/session-1/opencode-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama (SER8)/EXAONE 4.5 33B Q8' },
                { modelId: 'mlx/qwen3:0.6b', name: 'MLX/Qwen3 0.6B' }
            ],
            currentModelId: 'ollama/exaone:4.5-33b-q8'
        })
    })

    it('returns Cursor models for active Cursor sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'cursor' }
        })
        const { app } = createApp(session)

        const response = await app.request('/api/sessions/session-1/cursor-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'composer-2.5', name: 'Composer 2.5' },
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' }
            ],
            currentModelId: 'composer-2.5'
        })
    })

    it('rejects cursor-models for non-Cursor sessions', async () => {
        const { app } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/cursor-models')

        expect(response.status).toBe(400)
    })

    it('rejects opencode-models for non-OpenCode sessions', async () => {
        const { app } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/opencode-models')

        expect(response.status).toBe(400)
    })

    it('rejects OpenCode plan mode changes for local sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
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
            body: JSON.stringify({ mode: 'plan' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'OpenCode plan mode is only supported for remote sessions'
        })
        expect(applySessionConfigCalls).toEqual([])
    })

    it('applies OpenCode plan mode changes for remote sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'opencode' }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/permission-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'plan' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { permissionMode: 'plan' }]
        ])
    })

    it('applies permission mode changes for inactive sessions', async () => {
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

    it('rejects unsupported permission mode for flavor via resume body', async () => {
        const session = createSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' }
        })
        const { app } = createApp(session)

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionMode: 'bypassPermissions' })
        })

        expect(response.status).toBe(400)
    })

    it('passes permissionMode from resume body to resumeSession', async () => {
        const session = createSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'claude' }
        })
        let capturedResumeOpts: { permissionMode?: string } | undefined
        const { app } = createApp(session, {
            resumeSession: async (sessionId, _namespace, resumeOpts) => {
                capturedResumeOpts = resumeOpts
                return { type: 'success', sessionId }
            }
        })

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionMode: 'bypassPermissions' })
        })

        expect(response.status).toBe(200)
        expect(capturedResumeOpts).toEqual({ permissionMode: 'bypassPermissions' })
    })

    it('returns 409 when resume token is unavailable', async () => {
        const session = createSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'cursor' }
        })
        const { app } = createApp(session, {
            resumeSession: async () => ({
                type: 'error',
                message: 'Resume session ID unavailable. Start a new session in this directory, or retry after the agent has initialized.',
                code: 'resume_unavailable'
            })
        })

        const response = await app.request('/api/sessions/session-1/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Resume session ID unavailable. Start a new session in this directory, or retry after the agent has initialized.',
            code: 'resume_unavailable'
        })
    })

    it('falls back to metadata slash commands when RPC listing fails', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                slashCommands: ['help', 'memory', 'status']
            }
        })
        const { app } = createApp(session, {
            listSlashCommands: async () => {
                throw new Error('RPC unavailable')
            }
        })

        const response = await app.request('/api/sessions/session-1/slash-commands')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            commands: [
                { name: 'help', source: 'builtin' },
                { name: 'memory', source: 'builtin' },
                { name: 'status', source: 'builtin' }
            ]
        })
    })

    it('reopens an archived session and reports resumed=true', async () => {
        const session = createSession({
            active: false,
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                cursorSessionId: 'cursor-thread-1',
                cursorSessionProtocol: 'acp',
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            }
        })
        const reopenCalls: Array<[string, string]> = []
        const { app } = createApp(session, {
            reopenSession: async (sessionId, namespace) => {
                reopenCalls.push([sessionId, namespace])
                return { type: 'success', sessionId, resumed: true, cursorSessionProtocol: 'acp' }
            }
        })

        const response = await app.request('/api/sessions/session-1/reopen', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            sessionId: 'session-1',
            resumed: true,
            cursorSessionProtocol: 'acp'
        })
        expect(reopenCalls).toEqual([['session-1', 'default']])
    })

    it('reopens a running session as an idempotent no-op (resumed=false)', async () => {
        const session = createSession({ active: true })
        const { app } = createApp(session, {
            reopenSession: async (sessionId) => ({ type: 'success', sessionId, resumed: false })
        })

        const response = await app.request('/api/sessions/session-1/reopen', { method: 'POST' })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            sessionId: 'session-1',
            resumed: false
        })
    })

    it('returns 422 when a cursor archive is missing cursorSessionId', async () => {
        const session = createSession({
            active: false,
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                lifecycleState: 'archived'
            }
        })
        const { app } = createApp(session, {
            reopenSession: async () => ({
                type: 'incomplete',
                message: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                missing: ['cursorSessionId']
            })
        })

        const response = await app.request('/api/sessions/session-1/reopen', { method: 'POST' })

        expect(response.status).toBe(422)
        expect(await response.json()).toEqual({
            error: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
            missing: ['cursorSessionId']
        })
    })

    it('returns 404 when reopening a non-existent session', async () => {
        const session = createSession()
        const { app } = createApp(session, { sessionExists: false })

        const response = await app.request('/api/sessions/missing-id/reopen', { method: 'POST' })

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'Session not found' })
    })

    it('maps engine resume_unavailable into a 409', async () => {
        const session = createSession({ active: false })
        const { app } = createApp(session, {
            reopenSession: async () => ({
                type: 'error',
                message: 'Resume session ID unavailable',
                code: 'resume_unavailable'
            })
        })

        const response = await app.request('/api/sessions/session-1/reopen', { method: 'POST' })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Resume session ID unavailable',
            code: 'resume_unavailable'
        })
    })

    it('maps engine no_machine_online into a 503', async () => {
        const session = createSession({ active: false })
        const { app } = createApp(session, {
            reopenSession: async () => ({
                type: 'error',
                message: 'No machine online',
                code: 'no_machine_online'
            })
        })

        const response = await app.request('/api/sessions/session-1/reopen', { method: 'POST' })

        expect(response.status).toBe(503)
        expect((await response.json() as { code: string }).code).toBe('no_machine_online')
    })

    it('merges RPC and metadata slash commands without hiding built-ins', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                slashCommands: ['help', 'memory']
            }
        })
        const { app } = createApp(session, {
            listSlashCommands: async () => ({
                success: true,
                commands: [
                    { name: 'clear', source: 'builtin' },
                    { name: 'project-only', source: 'project', content: 'Project prompt' }
                ]
            })
        })

        const response = await app.request('/api/sessions/session-1/slash-commands')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            commands: [
                { name: 'help', source: 'builtin' },
                { name: 'memory', source: 'builtin' },
                { name: 'clear', source: 'builtin' },
                { name: 'project-only', source: 'project', content: 'Project prompt' }
            ]
        })
    })

})
