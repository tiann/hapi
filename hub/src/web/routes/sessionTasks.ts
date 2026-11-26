import { Hono } from 'hono'
import {
    checkSessionTaskStartAt,
    CreateSessionTaskRequestSchema,
    UpdateSessionTaskRequestSchema
} from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

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

    app.post('/sessions/:id/tasks', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = CreateSessionTaskRequestSchema.safeParse(body)
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
        return c.json({ task: engine.createSessionTask(sessionResult.sessionId, parsed.data) })
    })

    app.patch('/sessions/:id/tasks/:taskId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = UpdateSessionTaskRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const task = engine.updateSessionTask(sessionResult.sessionId, c.req.param('taskId'), parsed.data)
        if (!task) {
            return c.json({ error: 'Task not found' }, 404)
        }
        return c.json({ task })
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

        const deleted = await engine.deleteSessionTask(sessionResult.sessionId, c.req.param('taskId'))
        if (!deleted) {
            return c.json({ error: 'Task not found' }, 404)
        }
        return c.json({ ok: true })
    })

    return app
}
