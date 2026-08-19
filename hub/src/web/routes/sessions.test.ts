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
        serviceTier: null,
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
    archiveSession?: (sessionId: string) => Promise<void>
    getCursorChatStoreStatus?: SyncEngine['getCursorChatStoreStatus']
    listCodexModelsForSession?: SyncEngine['listCodexModelsForSession']
    forkConversation?: SyncEngine['forkConversation']
    rewindConversation?: SyncEngine['rewindConversation']
    suggestSessionTitle?: SyncEngine['suggestSessionTitle']
    updateSessionSummary?: SyncEngine['updateSessionSummary']
    createAttachment?: SyncEngine['createAttachment']
    deleteAttachment?: SyncEngine['deleteAttachment']
    deleteUploadFile?: SyncEngine['deleteUploadFile']
    readAttachment?: SyncEngine['readAttachment']
    setSessionPinned?: (sessionId: string, pinned: boolean) => void
    setSessionPinMode?: (sessionId: string, mode: 'none' | 'project' | 'global') => void
}) {
    const applySessionConfigCalls: Array<[string, Record<string, unknown>]> = []
    const applySessionConfig = async (sessionId: string, config: Record<string, unknown>) => {
        applySessionConfigCalls.push([sessionId, config])
    }
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
    const listGrokModelsForSession = async () => ({
        success: true,
        availableModels: [
            {
                modelId: 'grok-4.5',
                name: 'Grok 4.5',
                reasoningEfforts: [{ value: 'low', name: 'Low' }]
            }
        ],
        currentModelId: 'grok-4.5'
    })
    const listGrokReasoningEffortOptionsForSession = async () => ({
        success: true,
        options: [{ value: 'low', name: 'Low' }],
        currentValue: 'low'
    })
    const resumeSession = opts?.resumeSession ?? (async (sessionId: string) => ({ type: 'success', sessionId }))
    const reopenSession = opts?.reopenSession ?? (async (sessionId: string) => ({
        type: 'success' as const,
        sessionId,
        resumed: true
    }))
    const sessionExists = opts?.sessionExists !== false
    const archiveSessionMock = opts?.archiveSession ?? (async () => {})
    const engine = {
        resolveSessionAccess: () => sessionExists
            ? { ok: true, sessionId: session.id, session }
            : { ok: false, reason: 'not-found' },
        applySessionConfig,
        listCursorModelsForSession,
        listCodexModelsForSession: opts?.listCodexModelsForSession ?? (async () => ({
            success: true,
            models: []
        })),
        listOpencodeModelsForSession,
        listOpencodeReasoningEffortOptionsForSession,
        listGrokModelsForSession,
        listGrokReasoningEffortOptionsForSession,
        resumeSession,
        reopenSession,
        getCursorChatStoreStatus: opts?.getCursorChatStoreStatus ?? (async () => ({
            type: 'success' as const,
            status: { onDisk: true, store: 'acp' as const }
        })),
        archiveSession: archiveSessionMock,
        setSessionPinned: opts?.setSessionPinned ?? (() => {}),
        setSessionPinMode: opts?.setSessionPinMode ?? (() => {}),
        getSessionExport: opts?.getSessionExport ?? (() => ({
            type: 'success',
            payload: {
                schemaVersion: 2,
                exportedAt: 1_762_000_000_000,
                session,
                messages: [],
                scratchlist: []
            }
        })),
        listSlashCommands: opts?.listSlashCommands ?? (async () => ({
            success: true,
            commands: []
        })),
        forkConversation: opts?.forkConversation ?? (async () => ({ type: 'success', sessionId: 'child-1' })),
        rewindConversation: opts?.rewindConversation ?? (async () => ({ type: 'success' })),
        suggestSessionTitle: opts?.suggestSessionTitle ?? (async () => 'Generated title'),
        updateSessionSummary: opts?.updateSessionSummary ?? (async () => {}),
        createAttachment: opts?.createAttachment ?? (async () => ({ success: false, error: 'not configured' })),
        deleteAttachment: opts?.deleteAttachment ?? (async () => ({ success: false, error: 'not configured' })),
        deleteUploadFile: opts?.deleteUploadFile ?? (async () => ({ success: false, error: 'not configured' })),
        readAttachment: opts?.readAttachment ?? (async () => null)
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
    it('generates a title suggestion without changing session metadata', async () => {
        const suggest = async (sessionId: string) => {
            expect(sessionId).toBe('session-1')
            return 'Generated title'
        }
        const { app } = createApp(createSession(), { suggestSessionTitle: suggest })

        const response = await app.request('/api/sessions/session-1/title-suggestion', { method: 'POST' })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ title: 'Generated title' })
    })

    it('writes generated titles through the summary metadata endpoint', async () => {
        const updates: Array<[string, string]> = []
        const { app } = createApp(createSession(), {
            updateSessionSummary: async (sessionId, text) => {
                updates.push([sessionId, text])
            }
        })

        const response = await app.request('/api/sessions/session-1/summary', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '  Generated title  ' })
        })

        expect(response.status).toBe(200)
        expect(updates).toEqual([['session-1', 'Generated title']])
    })

    it('rejects an empty summary', async () => {
        const { app } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/summary', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '   ' })
        })

        expect(response.status).toBe(400)
    })

    it('updates the persisted pin mode', async () => {
        const calls: Array<[string, 'none' | 'project' | 'global']> = []
        const { app } = createApp(createSession(), {
            setSessionPinMode: (sessionId, mode) => calls.push([sessionId, mode])
        })

        const response = await app.request('/api/sessions/session-1/pin', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'global' })
        })

        expect(response.status).toBe(200)
        expect(calls).toEqual([['session-1', 'global']])
    })

    it('rejects an invalid pin body', async () => {
        const { app } = createApp(createSession())
        const response = await app.request('/api/sessions/session-1/pin', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'yes' })
        })

        expect(response.status).toBe(400)
    })

    it('uses session-scoped Codex model discovery for the fallback endpoint', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                machineId: 'machine-1'
            }
        })
        const captured: string[] = []
        const { app } = createApp(session, {
            listCodexModelsForSession: async (sessionId) => {
                captured.push(sessionId)
                return {
                    success: true,
                    models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }]
                }
            }
        })

        const response = await app.request('/api/sessions/session-1/codex-models')

        expect(response.status).toBe(200)
        expect(captured).toEqual(['session-1'])
        expect(await response.json()).toEqual({
            success: true,
            models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }]
        })
    })

    it('returns the machine-scoped Cursor chat store status', async () => {
        const session = createSession({
            active: false,
            metadata: {
                path: '/tmp/project',
                host: 'cursor-host',
                flavor: 'cursor',
                cursorSessionId: 'cursor-thread-1'
            }
        })
        const { app } = createApp(session, {
            getCursorChatStoreStatus: async () => ({
                type: 'success',
                status: { onDisk: false, store: null }
            })
        })

        const response = await app.request('/api/sessions/session-1/cursor-chat-store')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ onDisk: false, store: null })
    })

    it('exports an empty session conversation payload', async () => {
        const session = createSession()
        const { app } = createApp(session)

        const response = await app.request('/api/sessions/session-1/export')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            schemaVersion: 2,
            exportedAt: 1_762_000_000_000,
            session,
            messages: [],
            scratchlist: []
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
                    schemaVersion: 2,
                    exportedAt: 1_762_000_000_000,
                    session,
                    messages,
                    scratchlist: []
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

    it('applies fast service tier changes for remote Codex sessions', async () => {
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

    it('persists an explicit Standard service tier (distinct from untouched)', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/service-tier', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceTier: 'standard' })
        })

        expect(response.status).toBe(200)
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { serviceTier: 'standard' }]
        ])
    })

    it('rejects unsupported service tier values', async () => {
        const { app, applySessionConfigCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/service-tier', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceTier: 'turbo' })
        })

        expect(response.status).toBe(400)
        expect(applySessionConfigCalls).toEqual([])
    })

    it('rejects service tier changes for local Codex sessions', async () => {
        const { app, applySessionConfigCalls } = createApp(
            createSession({
                agentState: {
                    controlledByUser: true,
                    requests: {},
                    completedRequests: {}
                }
            })
        )

        const response = await app.request('/api/sessions/session-1/service-tier', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceTier: 'fast' })
        })

        expect(response.status).toBe(409)
        expect(applySessionConfigCalls).toEqual([])
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

    it('applies model changes for remote Grok sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'grok' }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'grok-4.5' })
        })

        expect(response.status).toBe(200)
        expect(applySessionConfigCalls).toEqual([
            ['session-1', { model: 'grok-4.5' }]
        ])
    })

    it('rejects model changes for local Grok sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'grok' },
            agentState: { controlledByUser: true, requests: {}, completedRequests: {} }
        })
        const { app, applySessionConfigCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'grok-4.5' })
        })

        expect(response.status).toBe(409)
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

    it('applies effort changes for remote Grok sessions and rejects local control', async () => {
        const remote = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'grok' }
        })
        const remoteApp = createApp(remote)
        const remoteResponse = await remoteApp.app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'low' })
        })
        expect(remoteResponse.status).toBe(200)
        expect(remoteApp.applySessionConfigCalls).toEqual([
            ['session-1', { effort: 'low' }]
        ])

        const local = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'grok' },
            agentState: { controlledByUser: true, requests: {}, completedRequests: {} }
        })
        const localApp = createApp(local)
        const localResponse = await localApp.app.request('/api/sessions/session-1/effort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ effort: 'low' })
        })
        expect(localResponse.status).toBe(409)
        expect(localApp.applySessionConfigCalls).toEqual([])
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

    it('returns Grok model and effort catalogs for active Grok sessions', async () => {
        const session = createSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'grok' }
        })
        const { app } = createApp(session)

        const modelsResponse = await app.request('/api/sessions/session-1/grok-models')
        expect(modelsResponse.status).toBe(200)
        expect(await modelsResponse.json()).toMatchObject({
            success: true,
            currentModelId: 'grok-4.5'
        })

        const effortResponse = await app.request('/api/sessions/session-1/grok-reasoning-effort-options')
        expect(effortResponse.status).toBe(200)
        expect(await effortResponse.json()).toEqual({
            success: true,
            options: [{ value: 'low', name: 'Low' }],
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

    // tiann/hapi#916: archive endpoint must be idempotent for already-archived
    // rows and for split-brain rows whose CLI is gone but the in-memory `active`
    // flag has not been reconciled to false yet.
    describe('POST /sessions/:id/archive (tiann/hapi#916)', () => {
        it('returns 2xx and calls archiveSession for an active session', async () => {
            const calls: string[] = []
            const session = createSession({ active: true })
            const { app } = createApp(session, {
                archiveSession: async (sessionId: string) => { calls.push(sessionId) }
            })

            const response = await app.request('/api/sessions/session-1/archive', { method: 'POST' })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ ok: true })
            expect(calls).toEqual(['session-1'])
        })

        it('archives an active session with stale archived lifecycle metadata', async () => {
            const calls: string[] = []
            const session = createSession({
                active: true,
                metadata: {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'archived'
                }
            })
            const { app } = createApp(session, {
                archiveSession: async (sessionId: string) => { calls.push(sessionId) }
            })

            const response = await app.request('/api/sessions/session-1/archive', { method: 'POST' })

            expect(response.status).toBe(200)
            expect(calls).toEqual(['session-1'])
            expect(await response.json()).toEqual({ ok: true })
        })

        it('returns 2xx and skips archiveSession when the row is already archived (idempotent)', async () => {
            let called = false
            const session = createSession({
                active: false,
                metadata: {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }
            })
            const { app } = createApp(session, {
                archiveSession: async () => { called = true }
            })

            const response = await app.request('/api/sessions/session-1/archive', { method: 'POST' })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ ok: true, alreadyArchived: true })
            expect(called).toBe(false)
        })

        it('returns 2xx when the active session\'s CLI is gone — engine.archiveSession swallows the missing-RPC error', async () => {
            // Pre-fix this returned 500 because rpcGateway.killSession threw
            // 'RPC handler not registered'. Post-fix the engine narrows on
            // RpcTargetMissingError and still flips lifecycle to archived.
            const session = createSession({ active: true })
            const { app } = createApp(session, {
                archiveSession: async () => {
                    // Simulates the post-fix behavior: engine catches the
                    // RpcTargetMissingError, calls markSessionArchivedFromHub,
                    // and returns normally.
                }
            })

            const response = await app.request('/api/sessions/session-1/archive', { method: 'POST' })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ ok: true })
        })

        it('still surfaces a 5xx for non-RPC errors (e.g. DB write failure)', async () => {
            const session = createSession({ active: true })
            const { app } = createApp(session, {
                archiveSession: async () => {
                    throw new Error('DB write failed')
                }
            })

            const response = await app.request('/api/sessions/session-1/archive', { method: 'POST' })
            expect(response.status).toBe(500)
        })

        it('returns 404 when the session id is unknown', async () => {
            const session = createSession()
            const { app } = createApp(session, { sessionExists: false })

            const response = await app.request('/api/sessions/missing-id/archive', { method: 'POST' })

            expect(response.status).toBe(404)
            expect(await response.json()).toEqual({ error: 'Session not found' })
        })

        it('returns 409 for an inactive non-archived row whose lifecycle is not running', async () => {
            let called = false
            const session = createSession({ active: false })
            const { app } = createApp(session, {
                archiveSession: async () => { called = true }
            })

            const response = await app.request('/api/sessions/session-1/archive', { method: 'POST' })

            expect(response.status).toBe(409)
            expect(await response.json()).toEqual({ error: 'Session is inactive' })
            expect(called).toBe(false)
        })

        it('returns 2xx for an inactive split-brain row still marked lifecycleState=running', async () => {
            const calls: string[] = []
            const session = createSession({
                active: false,
                metadata: {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'running'
                }
            })
            const { app } = createApp(session, {
                archiveSession: async (sessionId: string) => { calls.push(sessionId) }
            })

            const response = await app.request('/api/sessions/session-1/archive', { method: 'POST' })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ ok: true })
            expect(calls).toEqual(['session-1'])
        })
    })

    it('forks via POST /sessions/:id/fork and returns the child session id', async () => {
        const calls: Array<{ sessionId: string; namespace: string; messageLocalId?: string }> = []
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                capabilities: { conversationHistory: { forkCurrent: true } }
            }
        })
        const { app } = createApp(session, {
            forkConversation: async (sessionId, namespace, messageLocalId) => {
                calls.push({ sessionId, namespace, messageLocalId })
                return { type: 'success', sessionId: 'forked-child' }
            }
        })

        const response = await app.request('/api/sessions/session-1/fork', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ sessionId: 'forked-child' })
        expect(calls).toEqual([{ sessionId: 'session-1', namespace: 'default', messageLocalId: undefined }])
    })

    it('rewinds via POST /sessions/:id/rewind', async () => {
        const calls: Array<{ sessionId: string; messageLocalId: string }> = []
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                capabilities: { conversationHistory: { rewindToMessage: true } }
            }
        })
        const { app } = createApp(session, {
            rewindConversation: async (sessionId, _namespace, messageLocalId) => {
                calls.push({ sessionId, messageLocalId })
                return { type: 'success' }
            }
        })

        const response = await app.request('/api/sessions/session-1/rewind', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageLocalId: 'local-2' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true })
        expect(calls).toEqual([{ sessionId: 'session-1', messageLocalId: 'local-2' }])
    })

    it('rejects rewind without messageLocalId', async () => {
        const { app } = createApp(createSession())
        const response = await app.request('/api/sessions/session-1/rewind', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })
        expect(response.status).toBe(400)
    })

    it('honors optional limit on GET /sessions after sort', async () => {
        const sessions = [
            createSession({ id: 'older-active', active: true, updatedAt: 10 }),
            createSession({ id: 'newer-active', active: true, updatedAt: 20 }),
            createSession({ id: 'inactive', active: false, updatedAt: 30 })
        ]
        const scheduledIds: string[][] = []
        const engine = {
            getSessionsByNamespace: () => sessions,
            getFutureScheduledMessageCounts: (ids: string[]) => {
                scheduledIds.push(ids)
                return new Map(ids.map((id) => [id, 0]))
            },
            getNextScheduledAtBySessionIds: (_ids: string[]) => new Map<string, number>(),
            resolveSessionAccess: () => ({ ok: false, reason: 'not-found' as const })
        } as unknown as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine as SyncEngine))

        const limited = await app.request('/api/sessions?limit=2')
        expect(limited.status).toBe(200)
        const limitedBody = await limited.json() as { sessions: Array<{ id: string }> }
        expect(limitedBody.sessions.map((s) => s.id)).toEqual(['newer-active', 'older-active'])
        expect(scheduledIds.at(-1)).toEqual(['newer-active', 'older-active'])

        const unlimited = await app.request('/api/sessions')
        expect(unlimited.status).toBe(200)
        const unlimitedBody = await unlimited.json() as { sessions: Array<{ id: string }> }
        expect(unlimitedBody.sessions).toHaveLength(3)
    })

    it('order=updatedAt truncates newest-first including inactive peers', async () => {
        const sessions = [
            createSession({ id: 'old-active', active: true, updatedAt: 10 }),
            createSession({ id: 'new-inactive', active: false, updatedAt: 50 }),
            createSession({ id: 'mid-active', active: true, updatedAt: 20 })
        ]
        const engine = {
            getSessionsByNamespace: () => sessions,
            getFutureScheduledMessageCounts: (ids: string[]) => new Map(ids.map((id) => [id, 0])),
            getNextScheduledAtBySessionIds: (_ids: string[]) => new Map<string, number>(),
            resolveSessionAccess: () => ({ ok: false, reason: 'not-found' as const })
        } as unknown as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/sessions?limit=1&order=updatedAt')
        expect(response.status).toBe(200)
        const body = await response.json() as { sessions: Array<{ id: string }> }
        expect(body.sessions.map((s) => s.id)).toEqual(['new-inactive'])
    })

})

describe('durable attachment routes', () => {
    it('passes the original and optional thumbnail to the hub attachment store', async () => {
        const calls: unknown[][] = []
        const { app } = createApp(createSession(), {
            createAttachment: async (...args) => {
                calls.push(args)
                return {
                    success: true,
                    attachmentId: 'attachment-1',
                    filename: 'photo.png',
                    mimeType: 'image/png',
                    size: 3,
                    thumbnailAvailable: true
                }
            }
        })

        const response = await app.request('/api/sessions/session-1/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                filename: 'photo.png',
                content: 'AQID',
                mimeType: 'image/png',
                thumbnailContent: 'BAUG',
                thumbnailMimeType: 'image/webp'
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            attachmentId: 'attachment-1',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 3,
            thumbnailAvailable: true
        })
        expect(calls).toEqual([[
            'session-1',
            'default',
            'photo.png',
            'AQID',
            'image/png',
            'BAUG',
            'image/webp'
        ]])
    })

    it('returns durable attachment bytes with integrity headers', async () => {
        const { app } = createApp(createSession(), {
            readAttachment: async () => ({
                attachment: { filename: 'preview.webp' } as never,
                variant: 'thumbnail' as const,
                data: Buffer.from([7, 8, 9]),
                mimeType: 'image/webp',
                size: 3,
                sha256: 'hash-1'
            })
        })

        const response = await app.request('/api/sessions/session-1/attachments/attachment-1/thumbnail')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/webp')
        expect(response.headers.get('content-length')).toBe('3')
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="preview.webp"')
        expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
        expect(response.headers.get('cache-control')).toContain('immutable')
        expect(response.headers.get('etag')).toBe('"hash-1"')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9])
    })

    it('sandboxes active MIME types and sanitizes attachment filenames', async () => {
        const { app } = createApp(createSession(), {
            readAttachment: async () => ({
                attachment: { filename: 'evil"\r\n.html' } as never,
                variant: 'original' as const,
                data: Buffer.from('<script>alert(1)</script>'),
                mimeType: 'text/html',
                size: 25,
                sha256: 'html-hash'
            })
        })

        const response = await app.request('/api/sessions/session-1/attachments/attachment-1/original')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html')
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="evil___.html"')
        expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('encodes Unicode attachment filenames for API download headers', async () => {
        const { app } = createApp(createSession(), {
            readAttachment: async () => ({
                attachment: { filename: '截图😀.png' } as never,
                variant: 'original' as const,
                data: Buffer.from([1]),
                mimeType: 'image/png',
                size: 1,
                sha256: 'unicode-hash'
            })
        })

        const response = await app.request('/api/sessions/session-1/attachments/attachment-1/original')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-disposition')).toBe(
            "attachment; filename=\"____.png\"; filename*=UTF-8''%E6%88%AA%E5%9B%BE%F0%9F%98%80.png"
        )
    })

    it('deletes a durable attachment by opaque id without invoking the legacy path RPC', async () => {
        const durableCalls: string[][] = []
        const legacyCalls: string[][] = []
        const { app } = createApp(createSession(), {
            deleteAttachment: async (...args) => {
                durableCalls.push(args)
                return { success: true }
            },
            deleteUploadFile: async (...args) => {
                legacyCalls.push(args)
                return { success: true }
            }
        })

        const response = await app.request('/api/sessions/session-1/upload/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attachmentId: 'attachment-1' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true })
        expect(durableCalls).toEqual([['session-1', 'default', 'attachment-1']])
        expect(legacyCalls).toEqual([])
    })

    it('allows durable attachment cleanup for inactive sessions but keeps legacy deletion active-only', async () => {
        const durableCalls: string[][] = []
        const legacyCalls: string[][] = []
        const { app } = createApp(createSession({ active: false }), {
            deleteAttachment: async (...args) => {
                durableCalls.push(args)
                return { success: true }
            },
            deleteUploadFile: async (...args) => {
                legacyCalls.push(args)
                return { success: true }
            }
        })

        const durableResponse = await app.request('/api/sessions/session-1/upload/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attachmentId: 'attachment-1' })
        })
        expect(durableResponse.status).toBe(200)
        expect(await durableResponse.json()).toEqual({ success: true })

        const legacyResponse = await app.request('/api/sessions/session-1/upload/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: '/tmp/legacy-upload' })
        })
        expect(legacyResponse.status).toBe(409)
        expect(await legacyResponse.json()).toEqual({ error: 'Session is inactive' })
        expect(durableCalls).toEqual([['session-1', 'default', 'attachment-1']])
        expect(legacyCalls).toEqual([])
    })
})
