import { DshActionSchema, DshModelsResponseSchema, DshSkillsResponseSchema } from '@hapi/protocol'
import type { WebAppEnv } from '../middleware/auth'
import { Hono } from 'hono'
import { requireSessionFromParam, requireSyncEngine } from './guards'

/**
 * Session-scoped DeepSeek Harness action surface.
 *
 * Every endpoint validates against the shared allowlisted protocol
 * (DshActionSchema) and routes through the session-scoped CLI RPC after the
 * standard namespace/ownership check. There is no arbitrary method
 * passthrough, and host-global DSH surfaces (settings/credentials/preset
 * authoring) are intentionally not exposed here.
 */
export function createDshRoutes(getSyncEngine: () => import('../../sync/syncEngine').SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/dsh/action', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        if (sessionResult.session.metadata?.flavor !== 'dsh') {
            return c.json({ error: 'Session is not a DeepSeek Harness session' }, 400)
        }

        let action: unknown
        try {
            action = await c.req.json()
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400)
        }
        const parsed = DshActionSchema.safeParse(action)
        if (!parsed.success) {
            return c.json({ error: 'Invalid DSH action', issues: parsed.error.issues }, 400)
        }

        try {
            const result = await engine.dshAction(sessionResult.sessionId, parsed.data)
            return c.json({ ok: true, result })
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : String(error)
            }, 502)
        }
    })

    app.post('/sessions/:id/dsh/models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        if (sessionResult.session.metadata?.flavor !== 'dsh') {
            return c.json({ error: 'Session is not a DeepSeek Harness session' }, 400)
        }
        try {
            const result = await engine.dshModels(sessionResult.sessionId)
            const parsed = DshModelsResponseSchema.safeParse(result)
            if (!parsed.success) {
                return c.json({ error: 'Invalid model catalog from CLI' }, 502)
            }
            return c.json(parsed.data)
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : String(error)
            }, 502)
        }
    })

    app.post('/sessions/:id/dsh/skills', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        if (sessionResult.session.metadata?.flavor !== 'dsh') {
            return c.json({ error: 'Session is not a DeepSeek Harness session' }, 400)
        }
        try {
            const result = await engine.dshSkills(sessionResult.sessionId)
            const parsed = DshSkillsResponseSchema.safeParse(result)
            if (!parsed.success) {
                return c.json({ error: 'Invalid skill catalog from CLI' }, 502)
            }
            return c.json(parsed.data)
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : String(error)
            }, 502)
        }
    })

    return app
}
