import { Hono } from 'hono'
import { z } from 'zod'
import type { FetchMessagesResult, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    before: z.coerce.number().int().optional(),
    refresh: z.string().optional()
})

const sendMessageBodySchema = z.object({
    text: z.string().min(1)
})

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = querySchema.safeParse(c.req.query())
        const limit = parsed.success ? (parsed.data.limit ?? 50) : 50

        const before = parsed.success && Number.isFinite(parsed.data.before)
            ? (parsed.data.before ?? Number.POSITIVE_INFINITY)
            : Number.POSITIVE_INFINITY

        const refreshRaw = parsed.success ? parsed.data.refresh : undefined
        const refresh = refreshRaw === '1' || refreshRaw === 'true'

        const existing = engine.getSessionMessages(sessionId)
        let fetchResult: FetchMessagesResult | null = null
        if (refresh || existing.length === 0) {
            fetchResult = await engine.fetchMessages(sessionId)
        }

        const messages = engine.getSessionMessages(sessionId)
        const eligible = messages.filter((m) => m.createdAt < before)
        const slice = eligible.slice(Math.max(0, eligible.length - limit))
        const nextBefore = slice.length > 0 ? slice[0].createdAt : null
        const hasMore = eligible.length > slice.length

        return c.json({
            messages: slice,
            page: {
                limit,
                before: Number.isFinite(before) ? before : null,
                nextBefore,
                hasMore
            },
            warning: fetchResult && !fetchResult.ok
                ? { status: fetchResult.status, error: fetchResult.error }
                : null
        })
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = sendMessageBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        await engine.sendMessage(sessionId, parsed.data.text)
        return c.json({ ok: true })
    })

    return app
}
