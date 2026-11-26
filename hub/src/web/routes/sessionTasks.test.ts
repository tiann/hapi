import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { CreateSessionTaskRequest, SessionTask, UpdateSessionTaskRequest } from '@hapi/protocol'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionTaskRoutes } from './sessionTasks'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

function createSession(): Session {
    return {
        id: SESSION_ID,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: { path: '/tmp', host: 'local' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null
    } as Session
}

function wireTask(sessionId: string, overrides: Partial<SessionTask> = {}): SessionTask {
    return {
        id: 'task-1',
        sessionId,
        kind: 'repeat',
        state: 'active',
        items: [{ text: 'ping' }],
        intervalMs: 60_000,
        maxRuns: null,
        runCount: 0,
        totalRuns: null,
        nextRunAt: 1_000,
        pending: false,
        lastRunAt: null,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

function setup(options: { found?: boolean; engine?: Partial<Record<string, unknown>> } = {}) {
    const session = createSession()
    const engine = {
        resolveSessionAccess: () => (options.found === false
            ? { ok: false as const, reason: 'not-found' as const }
            : { ok: true as const, sessionId: session.id, session }),
        listSessionTasks: mock(() => [wireTask(session.id)]),
        createSessionTask: mock((_sessionId: string, _request: CreateSessionTaskRequest) => wireTask(session.id)),
        updateSessionTask: mock((_sessionId: string, _taskId: string, _patch: UpdateSessionTaskRequest) => wireTask(session.id, { state: 'paused', nextRunAt: null })),
        deleteSessionTask: mock(async (_sessionId: string, _taskId: string) => true),
        ...options.engine
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSessionTaskRoutes(() => engine))
    return { app, base: `http://localhost/api/sessions/${session.id}/tasks`, engine }
}

const post = (app: Hono<WebAppEnv>, url: string, body: unknown, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') => app.request(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }
})

describe('session task routes', () => {
    it('lists the tasks of one session', async () => {
        const { app, base, engine } = setup()
        const res = await app.request(base)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ tasks: [wireTask(SESSION_ID)] })
        expect((engine as unknown as { listSessionTasks: (id: string) => unknown }).listSessionTasks).toHaveBeenCalledWith(SESSION_ID)
    })

    it('creates a queue task from a valid body', async () => {
        const { app, base, engine } = setup()
        const body = { kind: 'queue', items: [{ text: '你好' }, { text: '吃饭了吗？' }], intervalMs: 600_000 }
        const res = await post(app, base, body)
        expect(res.status).toBe(200)
        expect((engine as unknown as { createSessionTask: (id: string, request: unknown) => unknown }).createSessionTask)
            .toHaveBeenCalledWith(SESSION_ID, body)
    })

    it('rejects a body the schema does not allow', async () => {
        const { app, base, engine } = setup()
        const create = (engine as unknown as { createSessionTask: { mock: { calls: unknown[] } } }).createSessionTask
        const status = async (body: unknown) => (await post(app, base, body)).status

        // Blank text, a queue without prompts, an interval under one minute, an unknown field.
        expect(await status({ kind: 'repeat', text: '   ', intervalMs: 60_000 })).toBe(400)
        expect(await status({ kind: 'queue', items: [], intervalMs: 60_000 })).toBe(400)
        expect(await status({ kind: 'repeat', text: 'ping', intervalMs: 1_000 })).toBe(400)
        expect(await status({ kind: 'repeat', text: 'ping', intervalMs: 60_000, attachments: [] })).toBe(400)
        expect(await status({ kind: 'loop', text: 'ping', intervalMs: 60_000 })).toBe(400)
        expect(await status(null)).toBe(400)
        expect(create.mock.calls).toEqual([])
    })

    it('rejects a first run that is too far in the past or the future', async () => {
        const { app, base } = setup()
        const postStartAt = async (startAt: number) => {
            const res = await post(app, base, { kind: 'repeat', text: 'ping', intervalMs: 60_000, startAt })
            return { status: res.status, body: await res.json() as { code?: string } }
        }

        expect(await postStartAt(Date.now() - 10 * 60_000)).toMatchObject({ status: 400, body: { code: 'invalid_start_at' } })
        expect(await postStartAt(Date.now() + 400 * 24 * 60 * 60_000)).toMatchObject({ status: 400, body: { code: 'invalid_start_at' } })
        // Just inside the grace window is accepted.
        expect((await postStartAt(Date.now() - 10_000)).status).toBe(200)
    })

    it('pauses and resumes through PATCH', async () => {
        const patch = mock((_sessionId: string, _taskId: string, body: UpdateSessionTaskRequest) =>
            wireTask(SESSION_ID, { state: body.paused ? 'paused' : 'active', nextRunAt: body.paused ? null : 2_000 }))
        const { app, base } = setup({ engine: { updateSessionTask: patch } })

        const paused = await post(app, `${base}/task-1`, { paused: true }, 'PATCH')
        expect(paused.status).toBe(200)
        expect(((await paused.json()) as { task: SessionTask }).task).toMatchObject({ state: 'paused', nextRunAt: null })
        expect(patch).toHaveBeenCalledWith(SESSION_ID, 'task-1', { paused: true })

        const resumed = await post(app, `${base}/task-1`, { paused: false }, 'PATCH')
        expect(((await resumed.json()) as { task: SessionTask }).task.state).toBe('active')

        // Missing or unknown fields are not a pause or a resume.
        expect((await post(app, `${base}/task-1`, {}, 'PATCH')).status).toBe(400)
        expect((await post(app, `${base}/task-1`, { paused: 'yes' }, 'PATCH')).status).toBe(400)
    })

    it('answers 404 for a task that is not in this session', async () => {
        const { app, base } = setup({ engine: { updateSessionTask: mock(() => null) } })
        expect((await post(app, `${base}/missing`, { paused: true }, 'PATCH')).status).toBe(404)
    })

    it('deletes a task', async () => {
        const { app, base, engine } = setup()
        const res = await post(app, `${base}/task-1`, undefined, 'DELETE')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect((engine as unknown as { deleteSessionTask: (id: string, taskId: string) => unknown }).deleteSessionTask)
            .toHaveBeenCalledWith(SESSION_ID, 'task-1')
    })

    it('answers 404 when deleting a task that is already gone', async () => {
        const { app, base } = setup({ engine: { deleteSessionTask: mock(async () => false) } })
        expect((await post(app, `${base}/task-1`, undefined, 'DELETE')).status).toBe(404)
    })

    it('answers 404 before touching the engine when the session does not exist', async () => {
        const { app, base, engine } = setup({ found: false })
        const list = (engine as unknown as { listSessionTasks: { mock: { calls: unknown[] } } }).listSessionTasks
        expect((await app.request(base)).status).toBe(404)
        expect((await post(app, `${base}/task-1`, undefined, 'DELETE')).status).toBe(404)
        expect((await post(app, base, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })).status).toBe(404)
        expect(list.mock.calls).toEqual([])
    })

    it('answers 503 when the hub has no engine yet', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionTaskRoutes(() => null))
        expect((await app.request('http://localhost/api/sessions/x/tasks')).status).toBe(503)
    })
})
