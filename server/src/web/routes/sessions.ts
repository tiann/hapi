import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

type SessionSummary = {
    id: string
    active: boolean
    thinking: boolean
    updatedAt: number
    createdAt: number
    permissionMode: Session['permissionMode']
    modelMode: Session['modelMode']
    metadata: Session['metadata']
    todos?: Session['todos']
    pendingRequestsCount: number
}

function toSessionSummary(session: Session): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0
    return {
        id: session.id,
        active: session.active,
        thinking: session.thinking,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        permissionMode: session.permissionMode,
        modelMode: session.modelMode,
        metadata: session.metadata,
        todos: session.todos,
        pendingRequestsCount
    }
}

const permissionModeSchema = z.object({
    mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan'])
})

const modelModeSchema = z.object({
    model: z.enum(['default', 'sonnet', 'opus'])
})

export function createSessionsRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessions = engine.getSessions()
            .map(toSessionSummary)
            .sort((a, b) => {
                // Active sessions first
                if (a.active !== b.active) {
                    return a.active ? -1 : 1
                }
                // Within active sessions, sort by pending requests count
                if (a.active && a.pendingRequestsCount !== b.pendingRequestsCount) {
                    return b.pendingRequestsCount - a.pendingRequestsCount
                }
                // Then by updatedAt
                return b.updatedAt - a.updatedAt
            })

        return c.json({ sessions })
    })

    app.get('/sessions/:id', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        return c.json({ session: sessionResult.session })
    })

    app.post('/sessions/:id/abort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.abortSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/permission-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = permissionModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        await engine.setPermissionMode(sessionResult.sessionId, parsed.data.mode)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/model', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = modelModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        await engine.setModelMode(sessionResult.sessionId, parsed.data.model)
        return c.json({ ok: true })
    })

    return app
}
