import { Hono, type Context, type Next } from 'hono'
import {
    checkSessionTaskStartAt,
    CreateSessionTaskRequestSchema,
    SESSION_TASK_MAX_ACTIVE_PER_SESSION,
    SESSION_TASK_MAX_ITEMS,
    SessionTaskRunListQuerySchema,
    UpdateSessionTaskRequestSchema
} from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

/** Task requests are small (50 prompts of at most 20 000 characters); a larger body is refused before it is parsed. */
const TASK_REQUEST_MAX_BYTES = 1024 * 1024
/**
 * How much of a refused body is still read before the 413 goes out (see
 * `taskBodyLimit`): above every body the field limits can produce — 50
 * prompts of 20 000 characters at four bytes each is about 4 MB — and
 * bounded all the same.
 */
export const TASK_REQUEST_DRAIN_MAX_BYTES = 8 * 1024 * 1024
const RUN_HISTORY_DEFAULT_LIMIT = 50
const TOO_MANY_TASKS_ERROR = `A session may hold at most ${SESSION_TASK_MAX_ACTIVE_PER_SESSION} active tasks`

const taskRequestTooLarge = (c: Context<WebAppEnv>) => c.json({ error: 'Task request too large' }, 413)

/**
 * Refuse a body over `TASK_REQUEST_MAX_BYTES` with a 413 — but only once the
 * body has been read.
 *
 * Bun closes a connection whose request body was left unread, and a close
 * over unread data is a reset, which can reach the client before the answer
 * does. A client that sends the whole body before it reads (Python's urllib)
 * then saw a reset instead of the 413 about half of the time; only a client
 * that read while sending, or omitted the length, got the answer reliably.
 * So an oversize body is read and discarded first, as far as
 * `TASK_REQUEST_DRAIN_MAX_BYTES`; past that the connection is reset after
 * all, which only a sender far beyond the documented limit meets. Whether
 * the length is declared makes no difference: the body is always read.
 *
 * A body within the limit is handed on whole, so the handler parses the same
 * bytes it would have read from the socket.
 */
async function taskBodyLimit(c: Context<WebAppEnv>, next: Next): Promise<Response | void> {
    const body = c.req.raw.body
    if (!body) return next()
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let read = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        read += value.byteLength
        if (read > TASK_REQUEST_MAX_BYTES) {
            // Read and throw away the rest, as far as the drain cap; a client
            // that went away in the meantime leaves nothing to read.
            try {
                while (read < TASK_REQUEST_DRAIN_MAX_BYTES) {
                    const rest = await reader.read()
                    if (rest.done) break
                    read += rest.value.byteLength
                }
            } catch {
                // The body could not be read to its end: the 413 goes out all the same.
            }
            return taskRequestTooLarge(c)
        }
        chunks.push(value)
    }
    const bytes = new Uint8Array(read)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    c.req.raw = new Request(c.req.raw, { body: bytes })
    return next()
}

/** The JSON body of a task request: null when it is not JSON. */
async function readJsonBody(c: Context<WebAppEnv>): Promise<unknown> {
    try {
        return await c.req.json()
    } catch {
        return null
    }
}

/**
 * A list of prompts longer than the cap is invalid whatever it holds. Zod
 * runs the element schema on every item before it checks the length, so the
 * list is cut to one past the cap first and Zod reports the same
 * `too_big` issue after validating at most 51 items.
 */
function capItems(body: unknown): unknown {
    if (body === null || typeof body !== 'object') return body
    const items = (body as { items?: unknown }).items
    if (!Array.isArray(items) || items.length <= SESSION_TASK_MAX_ITEMS) return body
    return { ...(body as Record<string, unknown>), items: items.slice(0, SESSION_TASK_MAX_ITEMS + 1) }
}

/**
 * Session tasks — hub-scheduled `repeat` / `queue` prompts. Every route is
 * scoped to one session and inherits its access check.
 */
export function createSessionTaskRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/tasks', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        return c.json({ tasks: engine.listSessionTasks(sessionResult.sessionId) })
    })

    /** What the session's tasks did, newest first. */
    app.get('/sessions/:id/tasks/history', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const parsed = SessionTaskRunListQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }
        const runs = engine.listSessionTaskRuns(sessionResult.sessionId, parsed.data.limit ?? RUN_HISTORY_DEFAULT_LIMIT)
        return c.json({ runs })
    })

    app.post('/sessions/:id/tasks', taskBodyLimit, async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await readJsonBody(c)
        const parsed = CreateSessionTaskRequestSchema.safeParse(capItems(body))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const startAtIssue = parsed.data.startAt !== undefined
            ? checkSessionTaskStartAt(parsed.data.startAt, Date.now())
            : null
        if (startAtIssue) {
            return c.json({
                error: startAtIssue === 'past'
                    ? 'startAt is too far in the past'
                    : 'startAt is too far in the future',
                code: 'invalid_start_at'
            }, 400)
        }
        const created = engine.createSessionTask(sessionResult.sessionId, parsed.data)
        if (created.type === 'too-many-tasks') {
            return c.json({
                error: TOO_MANY_TASKS_ERROR,
                code: 'too_many_tasks'
            }, 400)
        }
        return c.json({ task: created.task })
    })

    /** Edit a task: pause or resume it, or change its prompts, interval or run limit. */
    app.patch('/sessions/:id/tasks/:taskId', taskBodyLimit, async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await readJsonBody(c)
        const parsed = UpdateSessionTaskRequestSchema.safeParse(capItems(body))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const result = await engine.updateSessionTask(sessionResult.sessionId, c.req.param('taskId'), parsed.data)
        if (result.type === 'not-found') {
            return c.json({ error: 'Task not found' }, 404)
        }
        if (result.type === 'wrong-task-kind') {
            return c.json({
                error: `Not editable on a task of this kind: ${result.fields.join(', ')}`,
                code: 'wrong_task_kind'
            }, 400)
        }
        if (result.type === 'invalid-max-runs') {
            return c.json({
                error: 'maxRuns is below the number of prompts the task already sent',
                code: 'invalid_max_runs'
            }, 400)
        }
        if (result.type === 'too-many-tasks') {
            return c.json({
                error: TOO_MANY_TASKS_ERROR,
                code: 'too_many_tasks'
            }, 400)
        }
        return c.json({ task: result.task })
    })

    /** Send the task's next prompt now instead of waiting for its next run. */
    app.post('/sessions/:id/tasks/:taskId/run', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const result = engine.runSessionTaskNow(sessionResult.sessionId, c.req.param('taskId'))
        if (result.type === 'not-found') {
            return c.json({ error: 'Task not found' }, 404)
        }
        if (result.type === 'prompt-pending') {
            return c.json({
                error: 'A prompt of this task is still waiting to be taken',
                code: 'prompt_pending'
            }, 409)
        }
        if (result.type === 'too-many-tasks') {
            return c.json({
                error: TOO_MANY_TASKS_ERROR,
                code: 'too_many_tasks'
            }, 409)
        }
        return c.json({ task: result.task })
    })

    app.delete('/sessions/:id/tasks/:taskId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const result = await engine.deleteSessionTask(sessionResult.sessionId, c.req.param('taskId'))
        if (result.type === 'not-found') {
            return c.json({ error: 'Task not found' }, 404)
        }
        return c.json({ ok: true, prompt: result.prompt })
    })

    return app
}
