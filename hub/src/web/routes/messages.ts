import { Hono } from 'hono'
import { AttachmentMetadataSchema } from '@hapi/protocol/schemas'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    byPosition: z.string().optional(),
    beforeAt: z.coerce.number().int().min(0).optional(),
})

const sendMessageBodySchema = z.object({
    text: z.string(),
    localId: z.string().min(1).optional(),
    attachments: z.array(AttachmentMetadataSchema).optional()
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

        // V8 byPosition mode: use composite (position_at, seq) cursor
        if (parsed.success && parsed.data.byPosition === '1') {
            const beforeAt = parsed.data.beforeAt
            const beforeSeq = parsed.data.beforeSeq
            const before = (beforeAt !== undefined && beforeSeq !== undefined)
                ? { at: beforeAt, seq: beforeSeq }
                : null
            return c.json(engine.getMessagesPageByPosition(sessionId, { limit, before }))
        }

        // V7-compatible path: seq-based cursor
        const beforeSeq = parsed.success ? (parsed.data.beforeSeq ?? null) : null
        return c.json(engine.getMessagesPage(sessionId, { limit, beforeSeq }))
    })

    app.delete('/sessions/:id/messages/:messageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.cancelQueuedMessage(sessionId, messageId)
        return c.json(result)
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

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            sentFrom: 'webapp'
        })
        return c.json({ ok: true })
    })

    return app
}
