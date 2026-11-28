import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { CreateSessionTaskRequest, SessionTask, SessionTaskRun, UpdateSessionTaskRequest } from '@hapi/protocol'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionTaskRoutes, TASK_REQUEST_DRAIN_MAX_BYTES } from './sessionTasks'

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
        startAt: 1_000,
        lastRunAt: null,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

function wireRun(overrides: Partial<SessionTaskRun> = {}): SessionTaskRun {
    return {
        id: 'run-1',
        sessionId: SESSION_ID,
        taskId: 'task-1',
        taskKind: 'repeat',
        runNumber: 1,
        outcome: 'sent',
        scheduledFor: 1_000,
        recordedAt: 1_001,
        takenAt: null,
        detail: null,
        preview: 'ping',
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
        listSessionTaskRuns: mock((_sessionId: string, _limit: number) => [wireRun()]),
        createSessionTask: mock((_sessionId: string, _request: CreateSessionTaskRequest) => ({ type: 'created', task: wireTask(session.id) })),
        updateSessionTask: mock((_sessionId: string, _taskId: string, body: UpdateSessionTaskRequest) =>
            ({ type: 'updated', task: wireTask(session.id, { state: body.paused ? 'paused' : 'active', nextRunAt: body.paused ? null : 2_000 }) })),
        runSessionTaskNow: mock((_sessionId: string, _taskId: string) => ({ type: 'queued', task: wireTask(session.id) })),
        deleteSessionTask: mock(async (_sessionId: string, _taskId: string) => ({ type: 'deleted', prompt: 'none' as const })),
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
        expect(engine.listSessionTasks).toHaveBeenCalledWith(SESSION_ID)
    })

    describe('history', () => {
        it('lists the newest runs, 50 by default', async () => {
            const { app, base, engine } = setup()
            const res = await app.request(`${base}/history`)
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ runs: [wireRun()] })
            expect(engine.listSessionTaskRuns).toHaveBeenCalledWith(SESSION_ID, 50)
        })

        it('passes a limit in range through and rejects the rest of the query', async () => {
            const { app, base, engine } = setup()
            expect((await app.request(`${base}/history?limit=5`)).status).toBe(200)
            expect(engine.listSessionTaskRuns).toHaveBeenLastCalledWith(SESSION_ID, 5)
            expect((await app.request(`${base}/history?limit=200`)).status).toBe(200)
            expect((await app.request(`${base}/history?limit=201`)).status).toBe(400)
            expect((await app.request(`${base}/history?limit=0`)).status).toBe(400)
            expect((await app.request(`${base}/history?limit=abc`)).status).toBe(400)
            expect((await app.request(`${base}/history?limit=5&taskId=x`)).status).toBe(400)
        })

        it('answers 404 before the engine when the session does not exist', async () => {
            const { app, base, engine } = setup({ found: false })
            expect((await app.request(`${base}/history`)).status).toBe(404)
            expect(engine.listSessionTaskRuns).not.toHaveBeenCalled()
        })
    })

    it('creates a queue task from a valid body', async () => {
        const { app, base, engine } = setup()
        const body = { kind: 'queue', items: [{ text: '你好' }, { text: '吃饭了吗？' }], intervalMs: 600_000 }
        const res = await post(app, base, body)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ task: wireTask(SESSION_ID) })
        expect(engine.createSessionTask).toHaveBeenCalledWith(SESSION_ID, body)
    })

    it('rejects a body the schema does not allow', async () => {
        const { app, base, engine } = setup()
        const status = async (body: unknown) => (await post(app, base, body)).status

        // Blank text, a queue without prompts, an interval under one minute, an unknown field.
        expect(await status({ kind: 'repeat', text: '   ', intervalMs: 60_000 })).toBe(400)
        expect(await status({ kind: 'queue', items: [], intervalMs: 60_000 })).toBe(400)
        expect(await status({ kind: 'repeat', text: 'ping', intervalMs: 1_000 })).toBe(400)
        expect(await status({ kind: 'repeat', text: 'ping', intervalMs: 60_000, attachments: [] })).toBe(400)
        expect(await status({ kind: 'loop', text: 'ping', intervalMs: 60_000 })).toBe(400)
        expect(await status(null)).toBe(400)
        expect(engine.createSessionTask).not.toHaveBeenCalled()
    })

    it('rejects a queue with more than 50 prompts before validating them all', async () => {
        const { app, base, engine } = setup()
        // Long prompts keep the body under the byte limit, so the item cap is what refuses it.
        const items = Array.from({ length: 2_000 }, () => ({ text: 'x'.repeat(400) }))
        const res = await post(app, base, { kind: 'queue', items, intervalMs: 60_000 })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: string; issues: { fieldErrors: { items?: string[] } } }
        expect(body.error).toBe('Invalid body')
        expect(body.issues.fieldErrors.items?.[0]).toBe('Too big: expected array to have <=50 items')
        expect(engine.createSessionTask).not.toHaveBeenCalled()

        // 50 is the cap; 51 is not.
        expect((await post(app, base, { kind: 'queue', items: items.slice(0, 50), intervalMs: 60_000 })).status).toBe(200)
        expect((await post(app, base, { kind: 'queue', items: items.slice(0, 51), intervalMs: 60_000 })).status).toBe(400)
    })

    it('refuses a body over 1 MB without parsing it', async () => {
        const { app, base, engine } = setup()
        const oversize = { kind: 'repeat', text: 'x'.repeat(1_100_000), intervalMs: 60_000 }
        // With and without a declared content length (a chunked upload).
        const headerSets: Array<Record<string, string>> = [
            { 'Content-Type': 'application/json' },
            { 'Content-Type': 'application/json', 'Content-Length': String(JSON.stringify(oversize).length) }
        ]
        for (const headers of headerSets) {
            const res = await app.request(base, { method: 'POST', body: JSON.stringify(oversize), headers })
            expect(res.status).toBe(413)
            expect(await res.json()).toEqual({ error: 'Task request too large' })
        }
        const patch = await post(app, `${base}/task-1`, { text: 'x'.repeat(1_100_000) }, 'PATCH')
        expect(patch.status).toBe(413)
        expect(await patch.json()).toEqual({ error: 'Task request too large' })
        expect(engine.createSessionTask).not.toHaveBeenCalled()
        expect(engine.updateSessionTask).not.toHaveBeenCalled()
    })

    describe('a refused body is read first', () => {
        const PIECE = 64 * 1024

        /** A body handed over in `PIECE` pieces, as the hub pulls them; `pulled` counts the bytes it asked for. */
        function streamedBody(length: number | null) {
            const state = { pulled: 0, ended: false }
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (length !== null && state.pulled >= length) {
                        state.ended = true
                        controller.close()
                        return
                    }
                    controller.enqueue(new Uint8Array(PIECE))
                    state.pulled += PIECE
                }
            })
            return { body, state }
        }

        it('reads an oversize body to its end before it answers 413, with or without a declared length', async () => {
            const { app, base, engine } = setup()
            const total = 1024 * 1024 + 1
            const headerSets: Array<Record<string, string>> = [
                { 'Content-Type': 'application/json', 'Content-Length': String(total) },
                { 'Content-Type': 'application/json' }
            ]
            for (const headers of headerSets) {
                const { body, state } = streamedBody(total)
                const res = await app.request(base, { method: 'POST', body, headers, duplex: 'half' })
                expect(res.status).toBe(413)
                expect(await res.json()).toEqual({ error: 'Task request too large' })
                // The hub closes a connection whose request body it did not read, and a
                // close over an unread body is a reset that can swallow the answer on
                // its way to a client that sent the whole body first.
                expect(state.ended).toBe(true)
            }
            expect(engine.createSessionTask).not.toHaveBeenCalled()
        })

        it('stops reading a refused body at the drain cap', async () => {
            const { app, base } = setup()
            const { body, state } = streamedBody(null)
            const res = await app.request(base, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, duplex: 'half' })
            expect(res.status).toBe(413)
            expect(state.ended).toBe(false)
            // One piece may be pulled ahead of the last one read.
            expect(state.pulled).toBeLessThanOrEqual(TASK_REQUEST_DRAIN_MAX_BYTES + PIECE)
        })

        it('hands a body within the limit on whole', async () => {
            const { app, base, engine } = setup()
            // The largest body the schema allows: 50 prompts of 20 000 characters, just under the limit.
            const request = { kind: 'queue', items: Array.from({ length: 50 }, () => ({ text: 'x'.repeat(20_000) })), intervalMs: 60_000 }
            const bytes = new TextEncoder().encode(JSON.stringify(request))
            expect(bytes.byteLength).toBeGreaterThan(1_000_000)
            expect(bytes.byteLength).toBeLessThanOrEqual(1024 * 1024)
            // In pieces, so the body is put back together from more than one chunk.
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let offset = 0; offset < bytes.byteLength; offset += PIECE) {
                        controller.enqueue(bytes.subarray(offset, offset + PIECE))
                    }
                    controller.close()
                }
            })
            const res = await app.request(base, { method: 'POST', body: stream, headers: { 'Content-Type': 'application/json' }, duplex: 'half' })
            expect(res.status).toBe(200)
            expect(engine.createSessionTask).toHaveBeenCalledWith(SESSION_ID, request)
        })
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

    it('answers too_many_tasks when the session is at the cap', async () => {
        const { app, base } = setup({ engine: { createSessionTask: mock(() => ({ type: 'too-many-tasks' })) } })
        const res = await post(app, base, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ code: 'too_many_tasks' })
    })

    it('pauses and resumes through PATCH', async () => {
        const patch = mock((_sessionId: string, _taskId: string, body: UpdateSessionTaskRequest) =>
            ({ type: 'updated', task: wireTask(SESSION_ID, { state: body.paused ? 'paused' : 'active', nextRunAt: body.paused ? null : 2_000 }) }))
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

    it('PATCH waits for a pause that takes its prompt back and answers the task as it is after that', async () => {
        // A pause whose pull-back waits for the CLI's answer: the engine answers a while later, with the prompt gone.
        const final = wireTask(SESSION_ID, { kind: 'queue', state: 'paused', nextRunAt: null, pending: false, runCount: 0, totalRuns: 2 })
        const update = mock((_sessionId: string, _taskId: string, body: UpdateSessionTaskRequest) => new Promise<{ type: string; task: SessionTask }>((resolve) => {
            setTimeout(() => resolve({ type: 'updated', task: body.paused ? final : wireTask(SESSION_ID) }), 30)
        }))
        const { app, base } = setup({ engine: { updateSessionTask: update } })

        const res = await post(app, `${base}/task-1`, { paused: true }, 'PATCH')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ task: final })
    })

    it('edits every editable field through PATCH', async () => {
        const { app, base, engine } = setup()
        const body = { text: 'pong', intervalMs: 120_000, maxRuns: null, paused: false }
        const res = await post(app, `${base}/task-1`, body, 'PATCH')
        expect(res.status).toBe(200)
        expect(engine.updateSessionTask).toHaveBeenCalledWith(SESSION_ID, 'task-1', body)

        // A queue edit with too many prompts is refused like a create.
        const items = Array.from({ length: 51 }, () => ({ text: 'x' }))
        expect((await post(app, `${base}/task-1`, { items }, 'PATCH')).status).toBe(400)
    })

    it('answers wrong_task_kind and invalid_max_runs with their codes', async () => {
        const { app, base } = setup({
            engine: {
                updateSessionTask: mock((_sessionId: string, _taskId: string, body: UpdateSessionTaskRequest) => {
                    if (body.text !== undefined) return { type: 'wrong-task-kind', fields: ['text', 'maxRuns'] }
                    if (body.items !== undefined) return { type: 'wrong-task-kind', fields: ['items'] }
                    return { type: 'invalid-max-runs' }
                })
            }
        })

        const kind = await post(app, `${base}/task-1`, { items: [{ text: 'x' }] }, 'PATCH')
        expect(kind.status).toBe(400)
        expect(await kind.json()).toMatchObject({ code: 'wrong_task_kind', error: 'Not editable on a task of this kind: items' })
        const both = await post(app, `${base}/task-1`, { text: 'x', maxRuns: 4 }, 'PATCH')
        expect(await both.json()).toMatchObject({ code: 'wrong_task_kind', error: 'Not editable on a task of this kind: text, maxRuns' })

        const limit = await post(app, `${base}/task-1`, { maxRuns: 3 }, 'PATCH')
        expect(limit.status).toBe(400)
        expect(await limit.json()).toMatchObject({ code: 'invalid_max_runs' })
    })

    it('answers too_many_tasks when a resume would exceed the cap: 400 on PATCH, 409 on run now', async () => {
        const { app, base } = setup({
            engine: {
                updateSessionTask: mock(() => ({ type: 'too-many-tasks' })),
                runSessionTaskNow: mock(() => ({ type: 'too-many-tasks' }))
            }
        })

        const patch = await post(app, `${base}/task-1`, { paused: false }, 'PATCH')
        expect(patch.status).toBe(400)
        expect(await patch.json()).toEqual({ error: 'A session may hold at most 20 active tasks', code: 'too_many_tasks' })
        const run = await post(app, `${base}/task-1/run`, undefined)
        expect(run.status).toBe(409)
        expect(await run.json()).toEqual({ error: 'A session may hold at most 20 active tasks', code: 'too_many_tasks' })
    })

    it('answers 404 for a task that is not in this session', async () => {
        const { app, base } = setup({
            engine: {
                updateSessionTask: mock(() => ({ type: 'not-found' })),
                runSessionTaskNow: mock(() => ({ type: 'not-found' })),
                deleteSessionTask: mock(async () => ({ type: 'not-found' }))
            }
        })
        expect((await post(app, `${base}/missing`, { paused: true }, 'PATCH')).status).toBe(404)
        expect((await post(app, `${base}/missing/run`, undefined)).status).toBe(404)
        expect((await post(app, `${base}/missing`, undefined, 'DELETE')).status).toBe(404)
    })

    describe('run now', () => {
        it('answers the task and kicks the scheduler', async () => {
            const { app, base, engine } = setup()
            const res = await post(app, `${base}/task-1/run`, undefined)
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ task: wireTask(SESSION_ID) })
            expect(engine.runSessionTaskNow).toHaveBeenCalledWith(SESSION_ID, 'task-1')
        })

        it('answers 409 prompt_pending while a prompt of the task is waiting', async () => {
            const { app, base } = setup({ engine: { runSessionTaskNow: mock(() => ({ type: 'prompt-pending', task: wireTask(SESSION_ID, { pending: true }) })) } })
            const res = await post(app, `${base}/task-1/run`, undefined)
            expect(res.status).toBe(409)
            expect(await res.json()).toMatchObject({ code: 'prompt_pending' })
        })
    })

    describe('DELETE', () => {
        it('answers ok and what became of a pending prompt', async () => {
            const { app, base, engine } = setup({ engine: { deleteSessionTask: mock(async () => ({ type: 'deleted', prompt: 'unconfirmed' as const })) } })
            const res = await post(app, `${base}/task-1`, undefined, 'DELETE')
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ ok: true, prompt: 'unconfirmed' })
            expect(engine.deleteSessionTask).toHaveBeenCalledWith(SESSION_ID, 'task-1')
        })

        it('answers 404 when deleting a task that is already gone', async () => {
            const { app, base } = setup({ engine: { deleteSessionTask: mock(async () => ({ type: 'not-found' })) } })
            expect((await post(app, `${base}/task-1`, undefined, 'DELETE')).status).toBe(404)
        })
    })

    it('answers 404 before touching the engine when the session does not exist', async () => {
        const { app, base, engine } = setup({ found: false })
        expect((await app.request(base)).status).toBe(404)
        expect((await app.request(`${base}/history`)).status).toBe(404)
        expect((await post(app, `${base}/task-1`, undefined, 'DELETE')).status).toBe(404)
        expect((await post(app, `${base}/task-1/run`, undefined)).status).toBe(404)
        expect((await post(app, base, { kind: 'repeat', text: 'ping', intervalMs: 60_000 })).status).toBe(404)
        for (const name of ['listSessionTasks', 'listSessionTaskRuns', 'createSessionTask', 'updateSessionTask', 'runSessionTaskNow', 'deleteSessionTask'] as const) {
            expect((engine[name] as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([])
        }
    })

    it('answers 503 when the hub has no engine yet', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionTaskRoutes(() => null))
        expect((await app.request('http://localhost/api/sessions/x/tasks')).status).toBe(503)
        expect((await app.request('http://localhost/api/sessions/x/tasks/history')).status).toBe(503)
        expect((await post(app, 'http://localhost/api/sessions/x/tasks/t/run', undefined)).status).toBe(503)
    })
})
